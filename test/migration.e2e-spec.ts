import { DataSource } from 'typeorm';
import {
  ensureSchema,
  migrateNotificationClosure,
} from '../src/database/data-source';

/**
 * 数据库迁移 e2e：在“既有旧库”（无闭环新表、notification_records 无 content_version）
 * 上执行增量迁移，验证新表/新列/序列齐备、历史数据保留、迁移可重放。
 */
describe('回执-签收闭环 数据库迁移 (e2e)', () => {
  const SCRATCH_DB = 'eldercare_migration_test';
  let admin: DataSource;
  let scratch: DataSource;

  const adminOptions = () => ({
    type: 'postgres' as const,
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_DATABASE || 'eldercare_test',
  });

  beforeAll(async () => {
    admin = new DataSource(adminOptions());
    await admin.initialize();
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

    // 构造“旧库”：只有闭环前的旧表（notification_records 无 content_version）
    scratch = new DataSource({ ...adminOptions(), database: SCRATCH_DB });
    await scratch.initialize();
    await scratch.query(`
      CREATE TABLE notification_records (
        id uuid PRIMARY KEY,
        assessment_case_id uuid,
        status varchar(20) NOT NULL DEFAULT 'PENDING',
        notifiable_status varchar(20) NOT NULL,
        message text,
        failure_reason text,
        attempts integer NOT NULL DEFAULT 0,
        last_attempt_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await scratch.query(`
      CREATE TABLE grade_periods (
        id uuid PRIMARY KEY,
        elder_id varchar(64) NOT NULL,
        grade varchar(20) NOT NULL,
        start_date date NOT NULL,
        end_date_exclusive date,
        source_case_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // 历史告知记录（迁移前已存在的数据）
    await scratch.query(`
      INSERT INTO notification_records (id, assessment_case_id, status, notifiable_status, message, attempts)
      VALUES ('11111111-1111-1111-1111-111111111111',
              '22222222-2222-2222-2222-222222222222',
              'FAILED', 'UNCONFIRMED', '历史告知文本', 1)
    `);
  }, 120_000);

  afterAll(async () => {
    if (scratch?.isInitialized) await scratch.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
      await admin.destroy();
    }
  });

  it('增量迁移：新表/新列/序列齐备，历史数据保留且默认版本 v1', async () => {
    // grade_periods 已存在 → ensureSchema 走增量迁移路径（而非 synchronize）
    await ensureSchema(scratch);

    const tables = await scratch.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'notification%'
      ORDER BY table_name
    `);
    expect(tables.map((t: any) => t.table_name)).toEqual([
      'notification_content_versions',
      'notification_deliveries',
      'notification_receipts',
      'notification_records',
      'notification_signatures',
    ]);

    const columns = await scratch.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'notification_records' AND column_name = 'content_version'
    `);
    expect(columns).toHaveLength(1);

    const [legacy] = await scratch.query(
      `SELECT status, notifiable_status, content_version FROM notification_records
       WHERE id = '11111111-1111-1111-1111-111111111111'`,
    );
    expect(legacy).toMatchObject({
      status: 'FAILED',
      notifiable_status: 'UNCONFIRMED',
      content_version: 1,
    });

    const [seq] = await scratch.query(
      `SELECT nextval('notification_delivery_no_seq') AS v`,
    );
    expect(Number(seq.v)).toBeGreaterThan(0);

    // 关键约束/索引存在
    const constraints = await scratch.query(`
      SELECT conname FROM pg_constraint WHERE conname IN (
        'uq_notification_delivery_no',
        'uq_notification_attempt',
        'uq_notification_receipt_event',
        'uq_notification_signature_event',
        'uq_notification_signature_delivery',
        'uq_notification_content_version',
        'grade_periods_no_overlap'
      )
    `);
    expect(constraints).toHaveLength(7);
  });

  it('迁移可安全重放（幂等）', async () => {
    await expect(migrateNotificationClosure(scratch)).resolves.not.toThrow();
    await expect(ensureSchema(scratch)).resolves.not.toThrow();
    const [row] = await scratch.query(
      `SELECT count(*)::int AS c FROM notification_records`,
    );
    expect(row.c).toBe(1);
  });
});
