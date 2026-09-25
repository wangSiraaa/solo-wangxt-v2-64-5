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
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
  /** 家属已签收当前内容版本（回执-签收闭环完成） */
  SIGNED = 'SIGNED',
}

/** 单次投递尝试状态机：PENDING → ACCEPTED → DELIVERED / FAILED（终态粘滞，迟到回执仅留痕） */
export enum DeliveryStatus {
  /** 已创建，等待投递器回执 */
  PENDING = 'PENDING',
  /** 通道已受理 */
  ACCEPTED = 'ACCEPTED',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
}

/** 离线模拟多渠道投递器回传的事件类型 */
export enum ReceiptType {
  /** 受理 */
  ACCEPTED = 'ACCEPTED',
  /** 送达 */
  DELIVERED = 'DELIVERED',
  /** 失败 */
  FAILED = 'FAILED',
  /** 家属签收 */
  SIGNED = 'SIGNED',
}

export enum SignatureStatus {
  /** 绑定当前内容版本，签收生效 */
  VALID = 'VALID',
  /** 内容已被新版本替代，旧版迟到签收仅留痕、不生效 */
  SUPERSEDED = 'SUPERSEDED',
}

/** 离线模拟的投递通道（不连接真实短信/外部服务） */
export enum NotifyChannel {
  SMS = 'SMS',
  VOICE = 'VOICE',
  APP_PUSH = 'APP_PUSH',
}

export enum NotifiableStatus {
  CONFIRMED = 'CONFIRMED',
  UNCONFIRMED = 'UNCONFIRMED',
}

/** 量表不适用项（NA）如何影响分母：由量表版本自行定义 */
export enum NaPolicy {
  /** NA 项从分母中剔除 */
  EXCLUDE_FROM_DENOMINATOR = 'EXCLUDE_FROM_DENOMINATOR',
  /** NA 按 0 分计入分母（本演示量表不使用，仅展示枚举完整性） */
  COUNT_AS_ZERO = 'COUNT_AS_ZERO',
}
