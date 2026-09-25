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
import { NotificationSignoff } from '../entities/notification-signoff.entity';
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
  NotificationSignoff,
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

async function columnExists(
  dataSource: DataSource,
  table: string,
  column: string,
): Promise<boolean> {
  const rows = await dataSource.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return rows.length > 0;
}

async function indexExists(
  dataSource: DataSource,
  index: string,
): Promise<boolean> {
  const rows = await dataSource.query(
    `SELECT 1 FROM pg_indexes WHERE indexname = $1`,
    [index],
  );
  return rows.length > 0;
}

/**
 * 幂等建表/迁移 + 防重叠排除约束（首次启动建表；后续启动只补缺）。
 *
 * 可靠回执/签收闭环的增量迁移（对已有库也安全）：
 *  - notification_records 增补：kind / stable_delivery_no / attempt_no /
 *    anchor_notification_id / channel / content_snapshot / content_version /
 *    content_hash / is_current_version / superseded_by_id / superseded_at；
 *  - 新表 notification_deliveries / notification_receipts / notification_signoffs；
 *  - 既有扁平告知行回填为 ANCHOR（attempt_no=0, content_version=1, 当前版本）；
 *  - 签收“每投递至多一条 BOUND”的部分唯一索引。
 * 同一老人同一天不得出现重叠生效等级：
 *   btree_gist 提供 daterange 排他约束（半开区间，相邻期间首尾相接不算重叠）。
 */
export async function ensureSchema(dataSource: DataSource): Promise<void> {
  await dataSource.query('CREATE EXTENSION IF NOT EXISTS btree_gist');

  const exists = await dataSource.query(
    `SELECT to_regclass('grade_periods') IS NOT NULL AS ok`,
  );
  if (!exists[0].ok) {
    await dataSource.synchronize();
  } else if (!(await columnExists(dataSource, 'notification_records', 'kind'))) {
    // 已存在旧库但尚无回执/签收闭环表结构：先同步出新表与新列，再做数据回填
    await dataSource.synchronize();
    await backfillLegacyNotificationRows(dataSource);
  } else {
    // 新列/新表在后续版本中可能继续增加：synchronize 仅补缺（不删列、不改类型语义）
    await dataSource.synchronize();
  }

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

  // 每个投递至多一条有效（BOUND）签收；STALE_TRACE/DUPLICATE 不受限
  if (!(await indexExists(dataSource, 'uq_signoff_one_bound_per_delivery'))) {
    await dataSource.query(`
      CREATE UNIQUE INDEX uq_signoff_one_bound_per_delivery
        ON notification_signoffs (delivery_id)
        WHERE state = 'BOUND'
    `);
  }
}

/** 旧版扁平告知行回填：全部视为锚点告知、内容版本 1、当前版本 */
async function backfillLegacyNotificationRows(
  dataSource: DataSource,
): Promise<void> {
  await dataSource.query(`
    UPDATE notification_records
       SET kind = 'ANCHOR',
           attempt_no = 0,
           content_version = 1,
           is_current_version = TRUE
     WHERE kind IS NULL
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
