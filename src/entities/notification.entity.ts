import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import {
  DeliveryChannel,
  NotifiableStatus,
  NotificationKind,
  NotificationStatus,
} from '../common/enums';
import { AssessmentCase } from './assessment-case.entity';

/** 每次投递固化的不可变内容快照 */
export interface NoticeContentSnapshot {
  /** 告知文本全文（含虚构量表免责声明） */
  message: string;
  /** 确认等级（尚未确认时为 null） */
  confirmedGrade: string | null;
  /** 可告知状态 */
  notifiableStatus: NotifiableStatus;
  /** 量表版本标题 */
  scaleTitle: string | null;
  /** 家属联系方式 */
  familyContact: string | null;
  /** 内容版本号：案件内从 1 递增；未确认尝试为 0 */
  contentVersion: number;
  /** 快照内容哈希（SHA-256，hex），证明送达/签收的是同一明确内容 */
  contentHash: string;
  /** 生成该版本的来源：AGREEMENT（一致确认）/ REVIEW（复核确认）/ MANUAL_RENOTIFY（重新告知） */
  source: string;
  /** 重新告知时的补充说明（如有） */
  supplement: string | null;
  /** 固化时间 ISO 字符串 */
  capturedAt: string;
}

/**
 * 家属告知记录。
 * 兼容历史结构（每次尝试一行的扁平列表），新增可靠回执/签收闭环字段：
 *  - kind=ANCHOR：逻辑告知（确认时生成，代表一个内容版本）；
 *  - kind=ATTEMPT：一次具体投递尝试，归属 stableDeliveryNo（同号多次尝试即重试），
 *    attemptNo 在同一投递号内从 1 递增，并携带投递时刻的不可变内容快照。
 * 送达结果与可告知状态仍分开记录：“已发送/已受理”不等于“已确认送达”。
 */
@Entity('notification_records')
export class NotificationRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @ManyToOne(() => AssessmentCase, (c) => c.notifications, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assessment_case_id' })
  assessmentCase: AssessmentCase;

  @Column({
    name: 'kind',
    type: 'varchar',
    length: 10,
    default: NotificationKind.ANCHOR,
  })
  kind: NotificationKind;

  /** 稳定投递号：一次逻辑投递的全部尝试（含重试）共用；未确认尝试不产生投递号 */
  @Index()
  @Column({
    name: 'stable_delivery_no',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  stableDeliveryNo: string | null;

  /** 尝试序号：同一稳定投递号内从 1 递增；锚点行为 0 */
  @Column({ name: 'attempt_no', type: 'int', default: 0 })
  attemptNo: number;

  /** 归属的锚点告知（内容版本）；未确认尝试为 null */
  @Index()
  @Column({ name: 'anchor_notification_id', type: 'uuid', nullable: true })
  anchorNotificationId: string | null;

  /** 本次投递使用的渠道 */
  @Column({ name: 'channel', type: 'varchar', length: 16, nullable: true })
  channel: DeliveryChannel | null;

  /** 投递时的不可变内容快照（jsonb） */
  @Column({ name: 'content_snapshot', type: 'jsonb', nullable: true })
  contentSnapshot: NoticeContentSnapshot | null;

  /** 内容版本号：案件内从 1 递增；未确认尝试为 0 */
  @Column({ name: 'content_version', type: 'int', default: 1 })
  contentVersion: number;

  /** 内容哈希冗余列（便于按版本/内容核对证据链） */
  @Column({ name: 'content_hash', type: 'varchar', length: 64, nullable: true })
  contentHash: string | null;

  /** 是否为当前有效内容版本（旧版本为 false；旧版本迟到签收只留痕） */
  @Column({ name: 'is_current_version', type: 'boolean', default: true })
  isCurrentVersion: boolean;

  /** 被哪个新锚点告知替代（内容版本替代留痕） */
  @Index()
  @Column({ name: 'superseded_by_id', type: 'uuid', nullable: true })
  supersededById: string | null;

  @Column({
    name: 'superseded_at',
    type: 'timestamptz',
    nullable: true,
  })
  supersededAt: Date | null;

  @Column({ name: 'status', type: 'varchar', length: 20, default: NotificationStatus.PENDING })
  status: NotificationStatus;

  /** 告知对象的可告知状态：已确认 / 尚未确认（与送达结果分开记录） */
  @Column({ name: 'notifiable_status', type: 'varchar', length: 20 })
  notifiableStatus: NotifiableStatus;

  @Column({ name: 'message', type: 'text', nullable: true })
  message: string | null;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason: string | null;

  @Column({ name: 'attempts', type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'last_attempt_at', type: 'timestamptz', nullable: true })
  lastAttemptAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
