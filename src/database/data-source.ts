import { DataSource, DataSourceOptions } from 'typeorm';
import { ScaleVersion } from '../entities/scale-version.entity';
import { ScaleItem } from '../entities/scale-item.entity';
import { ScaleOption } from '../entities/scale-option.entity';
import { AssessmentCase } from '../entities/assessment-case.entity';
import { AssessorAnswer } from '../entities/assessor-answer.entity';
import { ReviewDecision } from '../entities/review-decision.entity';
import { NotificationRecord } from '../entities/notification.entity';
import { NotificationDelivery } from '../entities/notification-delivery.entity';
import { NotificationReceipt } from '../entities/notification-receipt.entity';
import { NotificationSignature } from '../entities/notification-signature.entity';
import { NotificationContentVersion } from '../entities/notification-content-version.entity';
import { GradeEffectivePeriod } from '../entities/grade-period.entity';
import { FeeRateVersion } from '../entities/fee-rate-version.entity';
import { seedDemoData } from './seed';

export const entities = [
  ScaleVersion,
  ScaleItem,
  ScaleOption,
  AssessmentCase,
  AssessorAnswer,
  ReviewDecision,
  NotificationRecord,
  NotificationDelivery,
  NotificationReceipt,
  NotificationSignature,
  NotificationContentVersion,
  GradeEffectivePeriod,
  FeeRateVersion,
];

export function buildDataSourceOptions(): DataSourceOptions {
  return {
    type: 'postgres',
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_DATABASE || 'eldercare',
    entities,
    synchronize: false,
  };
}

/**
 * 幂等建表 + 防重叠排除约束（首次启动建表；后续启动只补缺）。
 * 同一老人同一天不得出现重叠生效等级：
 *   btree_gist 提供 daterange 排他约束（半开区间，相邻期间首尾相接不算重叠）。
 */
export async function ensureSchema(dataSource: DataSource): Promise<void> {
  await dataSource.query('CREATE EXTENSION IF NOT EXISTS btree_gist');

  const exists = await dataSource.query(
    `SELECT to_regclass('grade_periods') IS NOT NULL AS ok`,
  );
  if (!exists[0].ok) {
    // 全新库：按实体一次性建表（含回执-签收闭环全部新表）
    await dataSource.synchronize();
  } else {
    // 既有库：增量迁移（回执-签收闭环），全部语句幂等可重放
    await migrateNotificationClosure(dataSource);
  }
  // 投递号序列（实体之外的独立对象，两种路径都保证存在）
  await dataSource.query(
    'CREATE SEQUENCE IF NOT EXISTS notification_delivery_no_seq',
  );

  const constraint = await dataSource.query(
    `SELECT 1 FROM pg_constraint WHERE conname = 'grade_periods_no_overlap'`,
  );
  if (constraint.length === 0) {
    await dataSource.query(`
      ALTER TABLE grade_periods
        ADD CONSTRAINT grade_periods_no_overlap
        EXCLUDE USING gist (
          elder_id WITH =,
          daterange(start_date, end_date_exclusive, '[)') WITH &&
        )
    `);
  }
}

/**
 * 既有数据库的增量迁移：可靠回执与签收闭环。
 * 在“等级确认生成告知记录”的既有模型上增加：
 *  - notification_records.content_version：当前内容版本号；
 *  - notification_content_versions：内容版本登记（替代历史留痕）；
 *  - notification_deliveries：每次投递的不可变快照 + 稳定投递号 + 尝试序号；
 *  - notification_receipts：append-only 回执日志（event_id 幂等）；
 *  - notification_signatures：家属签收（绑定已送达的明确内容版本）。
 * 所有语句 IF NOT EXISTS / IF NOT 重复，可安全重放。
 */
export async function migrateNotificationClosure(
  dataSource: DataSource,
): Promise<void> {
  await dataSource.query(`
    ALTER TABLE notification_records
      ADD COLUMN IF NOT EXISTS content_version integer NOT NULL DEFAULT 1
  `);

  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS notification_content_versions (
      id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      notification_id uuid NOT NULL REFERENCES notification_records(id) ON DELETE CASCADE,
      version integer NOT NULL,
      content text NOT NULL,
      content_hash varchar(64) NOT NULL,
      reason varchar(200),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_notification_content_version UNIQUE (notification_id, version)
    )
  `);

  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      notification_id uuid NOT NULL REFERENCES notification_records(id) ON DELETE CASCADE,
      delivery_no varchar(40) NOT NULL,
      attempt_no integer NOT NULL,
      channel varchar(20) NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'PENDING',
      notifiable_status varchar(20) NOT NULL,
      content_version integer NOT NULL,
      content_snapshot text NOT NULL,
      content_hash varchar(64) NOT NULL,
      idempotency_key varchar(128),
      failure_reason text,
      accepted_at timestamptz,
      delivered_at timestamptz,
      failed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_notification_delivery_no UNIQUE (delivery_no),
      CONSTRAINT uq_notification_attempt UNIQUE (notification_id, attempt_no)
    )
  `);
  await dataSource.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_idempotency_key_key
      ON notification_deliveries (idempotency_key) WHERE idempotency_key IS NOT NULL
  `);
  await dataSource.query(`
    CREATE INDEX IF NOT EXISTS idx_notification_deliveries_notification
      ON notification_deliveries (notification_id)
  `);

  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS notification_receipts (
      id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      delivery_id uuid NOT NULL REFERENCES notification_deliveries(id) ON DELETE CASCADE,
      event_id varchar(128) NOT NULL,
      delivery_no varchar(40) NOT NULL,
      attempt_no integer NOT NULL,
      type varchar(20) NOT NULL,
      occurred_at timestamptz NOT NULL,
      reason text,
      signer varchar(100),
      applied boolean NOT NULL DEFAULT false,
      note text,
      payload jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_notification_receipt_event UNIQUE (event_id)
    )
  `);
  await dataSource.query(`
    CREATE INDEX IF NOT EXISTS idx_notification_receipts_delivery
      ON notification_receipts (delivery_id)
  `);
  await dataSource.query(`
    CREATE INDEX IF NOT EXISTS idx_notification_receipts_created
      ON notification_receipts (created_at)
  `);

  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS notification_signatures (
      id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      notification_id uuid NOT NULL REFERENCES notification_records(id) ON DELETE CASCADE,
      delivery_id uuid NOT NULL REFERENCES notification_deliveries(id) ON DELETE CASCADE,
      event_id varchar(128) NOT NULL,
      delivery_no varchar(40) NOT NULL,
      attempt_no integer NOT NULL,
      content_version integer NOT NULL,
      content_hash varchar(64) NOT NULL,
      signer varchar(100) NOT NULL,
      status varchar(20) NOT NULL,
      signed_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_notification_signature_event UNIQUE (event_id),
      CONSTRAINT uq_notification_signature_delivery UNIQUE (delivery_id)
    )
  `);
  await dataSource.query(`
    CREATE INDEX IF NOT EXISTS idx_notification_signatures_notification
      ON notification_signatures (notification_id)
  `);
}

let singleton: Promise<DataSource> | null = null;

/** 一次性“连接-建表-种子”（独立脚本使用） */
export async function buildInitializedDataSource(): Promise<DataSource> {
  const ds = new DataSource(buildDataSourceOptions());
  await ds.initialize();
  await ensureSchema(ds);
  await seedDemoData(ds);
  return ds;
}

/** Nest 启动与 e2e 测试共用同一套“连接-建表-种子”流程 */
export function getOrCreateDataSource(): Promise<DataSource> {
  if (!singleton) {
    singleton = (async () => {
      const ds = new DataSource(buildDataSourceOptions());
      await ds.initialize();
      await ensureSchema(ds);
      await seedDemoData(ds);
      return ds;
    })();
    singleton.catch(() => {
      singleton = null; // 允许后续重试
    });
  }
  return singleton;
}
