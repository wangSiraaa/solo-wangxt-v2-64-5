import { EntityManager } from 'typeorm';
import { randomUUID } from 'crypto';
import {
  NotifiableStatus,
  NotificationKind,
  NotificationStatus,
} from '../common/enums';
import { AssessmentCase } from '../entities/assessment-case.entity';
import { NotificationRecord } from '../entities/notification.entity';
import { buildSnapshot, hashContent } from './notice-content.util';

/**
 * 等级确认（一致/复核）后生成锚点告知行：代表一个明确内容版本（PENDING 待送达）。
 * 内容版本号在案件内从 1 递增；后续“重新告知”生成新版本并替代旧版本。
 * 必须在调用方事务内执行（与案件确认/复核落库同一事务）。
 */
export async function createAnchorNotice(params: {
  em: EntityManager;
  assessmentCase: AssessmentCase;
  message: string;
  source: string;
  supplement?: string | null;
}): Promise<NotificationRecord> {
  const { em, assessmentCase, message, source, supplement = null } = params;

  const maxRows = await em.query(
    `SELECT COALESCE(MAX(content_version), 0) AS v
       FROM notification_records
      WHERE assessment_case_id = $1 AND kind = 'ANCHOR'`,
    [assessmentCase.id],
  );
  const contentVersion = Number(maxRows[0].v) + 1;

  const anchor = new NotificationRecord();
  anchor.id = randomUUID();
  anchor.assessmentCase = assessmentCase;
  anchor.kind = NotificationKind.ANCHOR;
  anchor.attemptNo = 0;
  anchor.stableDeliveryNo = null;
  anchor.anchorNotificationId = null;
  anchor.channel = null;
  anchor.contentVersion = contentVersion;
  anchor.isCurrentVersion = true;
  anchor.supersededById = null;
  anchor.supersededAt = null;
  anchor.status = NotificationStatus.PENDING;
  anchor.notifiableStatus = NotifiableStatus.CONFIRMED;
  anchor.message = message;
  anchor.contentHash = hashContent(message);
  anchor.contentSnapshot = buildSnapshot({
    message,
    assessmentCase,
    notifiableStatus: NotifiableStatus.CONFIRMED,
    contentVersion,
    source,
    supplement,
  });
  anchor.failureReason = null;
  anchor.attempts = 0;
  anchor.lastAttemptAt = null;
  return em.save(anchor);
}
