import { CaseStatus, GradeCode } from './enums';

export interface NoticeTextInput {
  elderName: string;
  scaleTitle: string;
  status: CaseStatus;
  confirmedGrade: GradeCode | null;
  /** 复核意见（系统一致确认时为系统说明）；未确认案件可为空 */
  reviewComment?: string | null;
  /** 复核员；SYSTEM 表示两位评估员一致由系统确认 */
  reviewerId?: string | null;
}

/**
 * 家属告知文本的唯一构造入口。
 * 评估确认、管理复核、告知尝试与“内容刷新（生成新版本）”共用同一模板，
 * 保证相同案件状态下重新生成的文本逐字一致（内容版本不会因模板漂移而误升版）。
 */
export function buildFamilyNoticeText(input: NoticeTextInput): string {
  if (input.status !== CaseStatus.CONFIRMED || !input.confirmedGrade) {
    return (
      `告知尝试：${input.elderName} 的评估等级尚未确认` +
      `（案件状态 ${input.status}），暂无可告知等级。`
    );
  }
  if (input.reviewerId && input.reviewerId !== 'SYSTEM') {
    return (
      `家属告知：${input.elderName} 的${input.scaleTitle}评估等级` +
      `经管理复核确认为 ${input.confirmedGrade}。` +
      `复核意见：${input.reviewComment ?? ''} ` +
      `本评估为虚构行政流程演示，不构成医疗诊断或护理建议。`
    );
  }
  const basis = input.reviewComment ? `确认依据：${input.reviewComment} ` : '';
  return (
    `家属告知：${input.elderName} 的${input.scaleTitle}评估等级` +
    `已确认为 ${input.confirmedGrade}。${basis}` +
    `本评估为虚构行政流程演示，不构成医疗诊断或护理建议。`
  );
}
