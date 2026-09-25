/** 评估案件状态：必填项缺失不得定级；冲突进入复核而非自动取高 */
export enum CaseStatus {
  /** 评估员答案缺失必填项，无法定级，需补充/重新评估 */
  INCOMPLETE = 'INCOMPLETE',
  /** 两位评估员等级一致，系统确认（系统生成“一致确认”复核记录） */
  CONFIRMED = 'CONFIRMED',
  /** 两位评估员结果冲突，等待管理复核 */
  PENDING_REVIEW = 'PENDING_REVIEW',
}

export enum GradeCode {
  LIGHT = 'LIGHT', // 轻度失能
  MODERATE = 'MODERATE', // 中度失能
  SEVERE = 'SEVERE', // 重度失能
}

export enum ReviewResult {
  /** 双评估员一致，系统直接确认 */
  AGREEMENT = 'AGREEMENT',
  /** 冲突案件由管理员复核确认 */
  CONFIRMED = 'CONFIRMED',
}

export enum NotificationStatus {
  /** 等级已确认，待送达 */
  PENDING = 'PENDING',
  /** 离线投递器已受理（已发送但尚无送达确认，不能等同于已确认送达） */
  ACCEPTED = 'ACCEPTED',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
  /** 该告知内容版本已被新版本替代（旧版本迟到签收只留痕，不绑定） */
  SUPERSEDED = 'SUPERSEDED',
}

export enum NotifiableStatus {
  CONFIRMED = 'CONFIRMED',
  UNCONFIRMED = 'UNCONFIRMED',
}

/** 告知记录行类型：锚点行（逻辑告知/内容版本）或具体投递尝试行 */
export enum NotificationKind {
  ANCHOR = 'ANCHOR',
  ATTEMPT = 'ATTEMPT',
}

/** 离线模拟的多渠道投递器渠道（不连接真实短信或外部服务） */
export enum DeliveryChannel {
  SMS = 'SMS',
  WECHAT = 'WECHAT',
  VOICE = 'VOICE',
  ONSITE = 'ONSITE',
}

/** 投递器异步回传的事件类型 */
export enum ReceiptEvent {
  /** 渠道已受理：仅证明“已发送”，不得当作送达 */
  ACCEPTED = 'ACCEPTED',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
  /** 家属通过渠道回传的签收（仍需服务端归并校验版本与送达状态） */
  SIGNED = 'SIGNED',
}

/**
 * 签收归并结果：
 *  BOUND       —— 正常绑定到已送达的当前内容版本（形成证据链）
 *  STALE_TRACE —— 旧内容版本迟到签收：不绑定有效签收，仅留痕
 *  DUPLICATE   —— 重复签收：不新增结果，仅追加去重后的签收痕迹
 */
export enum SignoffState {
  BOUND = 'BOUND',
  STALE_TRACE = 'STALE_TRACE',
  DUPLICATE = 'DUPLICATE',
}

/** 量表不适用项（NA）如何影响分母：由量表版本自行定义 */
export enum NaPolicy {
  /** NA 项从分母中剔除 */
  EXCLUDE_FROM_DENOMINATOR = 'EXCLUDE_FROM_DENOMINATOR',
  /** NA 按 0 分计入分母（本演示量表不使用，仅展示枚举完整性） */
  COUNT_AS_ZERO = 'COUNT_AS_ZERO',
}
