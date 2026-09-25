import { createHash } from 'crypto';
import { NotifiableStatus } from '../common/enums';
import { AssessmentCase } from '../entities/assessment-case.entity';
import {
  NoticeContentSnapshot,
} from '../entities/notification.entity';

/**
 * 告知文本与不可变内容快照构造（评估确认、复核确认、重新告知共用同一口径）。
 * 快照一旦固化不可修改；送达/签收均以快照中的 contentHash 绑定明确内容版本。
 */

export function agreementNoticeText(
  elderName: string,
  scaleTitle: string,
  grade: string,
  basis: string,
): string {
  return (
    `家属告知：${elderName} 的${scaleTitle}评估等级已确认为 ${grade}。` +
    `确认依据：${basis} 本评估为虚构行政流程演示，不构成医疗诊断或护理建议。`
  );
}

export function reviewNoticeText(
  elderName: string,
  scaleTitle: string,
  grade: string,
  comment: string,
): string {
  return (
    `家属告知：${elderName} 的${scaleTitle}评估等级经管理复核确认为 ` +
    `${grade}。复核意见：${comment} ` +
    `本评估为虚构行政流程演示，不构成医疗诊断或护理建议。`
  );
}

/** 重新告知（内容新版本）文本：在等级告知基础上附加版本说明 */
export function renotifyNoticeText(
  elderName: string,
  scaleTitle: string,
  grade: string,
  supplement: string | null,
): string {
  const suffix = supplement ? `补充说明：${supplement} ` : '';
  return (
    `家属告知（最新版本）：${elderName} 的${scaleTitle}评估等级为 ` +
    `${grade}。${suffix}本评估为虚构行政流程演示，不构成医疗诊断或护理建议。`
  );
}

/** 尚未确认案件的尝试告知文本（兼容历史口径） */
export function unconfirmedNoticeText(
  elderName: string,
  caseStatus: string,
): string {
  return (
    `告知尝试：${elderName} 的评估等级尚未确认` +
    `（案件状态 ${caseStatus}），暂无可告知等级。`
  );
}

export function hashContent(message: string): string {
  return createHash('sha256').update(message, 'utf8').digest('hex');
}

export function buildSnapshot(params: {
  message: string;
  assessmentCase: AssessmentCase;
  notifiableStatus: NotifiableStatus;
  contentVersion: number;
  source: string;
  supplement?: string | null;
}): NoticeContentSnapshot {
  const {
    message,
    assessmentCase,
    notifiableStatus,
    contentVersion,
    source,
    supplement = null,
  } = params;
  return {
    message,
    confirmedGrade: assessmentCase.confirmedGrade ?? null,
    notifiableStatus,
    scaleTitle: assessmentCase.scaleVersion?.title ?? null,
    familyContact: assessmentCase.familyContact ?? null,
    contentVersion,
    contentHash: hashContent(message),
    source,
    supplement,
    capturedAt: new Date().toISOString(),
  };
}
