import { DataSource } from 'typeorm';
import {
  buildDataSourceOptions,
  ensureSchema,
} from '../src/database/data-source';
import { seedDemoData } from '../src/database/seed';
import {
  NotificationKind,
  NotificationStatus,
  NotifiableStatus,
} from '../src/common/enums';

/**
 * 数据库迁移 e2e：在“旧版库（仅有扁平 notification_records 表）”上执行 ensureSchema，
 * 验证新表/新列幂等补齐、旧告知行回填为 ANCHOR（version 1、当前版本），
 * 且迁移后新闭环结构可正常写入。
 */
describe('数据库迁移：旧版告知表升级到可靠回执/签收结构 (e2e)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = new DataSource(buildDataSourceOptions());
    await ds.initialize();
  });

  afterAll(async () => {
    await ds.destroy();
  });

  it('旧表行回填为 ANCHOR 且重复迁移幂等', async () => {
    // 先确保基础库存在（幂等建表 + 种子）；随后把告知结构降回旧版模拟升级场景
    await ensureSchema(ds);
    await seedDemoData(ds);

    // 1) 造一个最小案件
    const scale = await ds.query(
      `SELECT id FROM scale_versions WHERE code='DEMO_ADL' LIMIT 1`,
    );
    const elderId = 'E-MIGRATE';
    const inserted = await ds.query(
      `INSERT INTO assessment_cases
        (id, elder_id, elder_name, family_contact, scale_version_id, status,
         conflicting, created_at)
       VALUES (gen_random_uuid(), $1, '迁移老人', '13800000002', $2, 'CONFIRMED',
               false, now())
       RETURNING id`,
      [elderId, scale[0].id],
    );
    const caseId: string = inserted[0].id;

    try {
      // 2) 拆除闭环新结构，模拟旧版库
      await ds.query(`DROP TABLE IF EXISTS notification_signoffs`);
      await ds.query(`DROP TABLE IF EXISTS notification_receipts`);
      await ds.query(`DROP TABLE IF EXISTS notification_deliveries`);
      await ds.query(`
        ALTER TABLE notification_records
          DROP COLUMN IF EXISTS kind,
          DROP COLUMN IF EXISTS stable_delivery_no,
          DROP COLUMN IF EXISTS attempt_no,
          DROP COLUMN IF EXISTS anchor_notification_id,
          DROP COLUMN IF EXISTS channel,
          DROP COLUMN IF EXISTS content_snapshot,
          DROP COLUMN IF EXISTS content_version,
          DROP COLUMN IF EXISTS content_hash,
          DROP COLUMN IF EXISTS is_current_version,
          DROP COLUMN IF EXISTS superseded_by_id,
          DROP COLUMN IF EXISTS superseded_at
      `);
      await ds.query(`DROP INDEX IF EXISTS uq_signoff_one_bound_per_delivery`);

      // 3) 写入两条旧版告知行（旧列集合）
      await ds.query(
        `INSERT INTO notification_records
           (id, assessment_case_id, status, notifiable_status, message,
            failure_reason, attempts, last_attempt_at, created_at)
         VALUES (gen_random_uuid(), $1, 'PENDING', 'CONFIRMED', '旧告知1', NULL,
                 0, NULL, now()),
                (gen_random_uuid(), $1, 'FAILED', 'CONFIRMED', '旧告知2失败',
                 '号码无效', 1, now(), now())`,
        [caseId],
      );

      // 4) 执行迁移（幂等建表/补列/回填/部分唯一索引）
      await ensureSchema(ds);
      await ensureSchema(ds); // 再次执行必须幂等无报错

      // 5) 旧行回填正确（created_at 相同，按消息内容显式取行）
      const pendingRow = await ds.query(
        `SELECT status, kind, attempt_no, content_version, is_current_version,
                stable_delivery_no, notifiable_status, message
           FROM notification_records
          WHERE assessment_case_id = $1 AND message = '旧告知1'`,
        [caseId],
      );
      const failedRow = await ds.query(
        `SELECT status, stable_delivery_no, kind, content_version
           FROM notification_records
          WHERE assessment_case_id = $1 AND message = '旧告知2失败'`,
        [caseId],
      );
      const legacyCount = await ds.query(
        `SELECT count(*)::int AS n FROM notification_records
          WHERE assessment_case_id = $1`,
        [caseId],
      );
      expect(legacyCount[0].n).toBe(2);
      expect(pendingRow[0]).toMatchObject({
        kind: NotificationKind.ANCHOR,
        attempt_no: 0,
        content_version: 1,
        is_current_version: true,
        status: NotificationStatus.PENDING,
        notifiable_status: NotifiableStatus.CONFIRMED,
        message: '旧告知1',
      });
      // 旧行的送达状态原样保留（不被迁移改写）
      expect(failedRow[0].status).toBe(NotificationStatus.FAILED);
      expect(failedRow[0].stable_delivery_no).toBeNull();

      // 6) 新结构可用：写一个投递（验证外键/约束完整）
      await ds.query(
        `INSERT INTO notification_deliveries
           (id, assessment_case_id, stable_delivery_no, anchor_notification_id,
            content_version, content_hash, attempt_count, aggregate_status,
            winning_attempt_no, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'DLV-MIGRATE0001',
                 (SELECT id FROM notification_records
                   WHERE assessment_case_id=$1 AND message='旧告知1' LIMIT 1),
                 1, repeat('a',64), 1, 'DELIVERED', 1, now(), now())`,
        [caseId],
      );
      const deliverables = await ds.query(
        `SELECT aggregate_status FROM notification_deliveries
          WHERE stable_delivery_no='DLV-MIGRATE0001'`,
      );
      expect(deliverables[0].aggregate_status).toBe(
        NotificationStatus.DELIVERED,
      );
    } finally {
      // 清理本用例数据（外键顺序）
      await ds.query(
        `DELETE FROM notification_signoffs WHERE delivery_id IN
          (SELECT id FROM notification_deliveries WHERE assessment_case_id=$1)`,
        [caseId],
      );
      await ds.query(
        `DELETE FROM notification_receipts WHERE stable_delivery_no='DLV-MIGRATE0001'`,
      );
      await ds.query(
        `DELETE FROM notification_deliveries WHERE assessment_case_id=$1`,
        [caseId],
      );
      await ds.query(
        `DELETE FROM notification_records WHERE assessment_case_id=$1`,
        [caseId],
      );
      await ds.query(`DELETE FROM assessment_cases WHERE id=$1`, [caseId]);
    }
  }, 120_000);
});
