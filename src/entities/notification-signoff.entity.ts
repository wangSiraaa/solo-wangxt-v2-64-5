import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { SignoffState } from '../common/enums';
import { NotificationDelivery } from './notification-delivery.entity';

/**
 * 家属签收。闭环规则：
 *  - 只能绑定到“已送达（DELIVERED）”且“当前内容版本”的投递（BOUND）；
 *  - 告知内容被新版本替代后，旧版本迟到签收不绑定，仅留痕（STALE_TRACE）；
 *  - 重复签收不新增结果（同投递已有 BOUND → DUPLICATE；同 signoffKey 唯一约束兜底）；
 *  - 签收固化送达内容版本与哈希，形成 投递→送达→签收 的证据链。
 * 每个投递至多一条 BOUND 签收（部分唯一索引）。
 */
@Entity('notification_signoffs')
export class NotificationSignoff {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 签收请求方提供的幂等键（家属在回执/接口上携带） */
  @Index({ unique: true })
  @Column({ name: 'signoff_key', type: 'varchar', length: 128 })
  signoffKey: string;

  @Index()
  @Column({ name: 'stable_delivery_no', type: 'varchar', length: 32 })
  stableDeliveryNo: string;

  /** 签收指向的尝试序号（可能是旧尝试） */
  @Column({ name: 'attempt_no', type: 'int' })
  attemptNo: number;

  /** 签收时投递的内容版本/哈希快照（用于比对是否为明确内容版本） */
  @Column({ name: 'content_version', type: 'int' })
  contentVersion: number;

  @Column({ name: 'content_hash', type: 'varchar', length: 64 })
  contentHash: string;

  @Column({ name: 'state', type: 'varchar', length: 16 })
  state: SignoffState;

  /** 留痕说明（旧版本签收、重复签收的原因） */
  @Column({ name: 'trace_note', type: 'text', nullable: true })
  traceNote: string | null;

  /** 家属签名/确认人（演示） */
  @Column({ name: 'signer', type: 'varchar', length: 128, nullable: true })
  signer: string | null;

  /** 签收渠道 */
  @Column({ name: 'channel', type: 'varchar', length: 16, nullable: true })
  channel: string | null;

  @Column({ name: 'signed_at', type: 'timestamptz' })
  signedAt: Date;

  @ManyToOne(() => NotificationDelivery, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'delivery_id' })
  delivery: NotificationDelivery;

  @Column({ name: 'delivery_id', type: 'uuid' })
  deliveryId: string;

  /** 送达回执（DELIVERED）引用，BOUND 时非空：证据链闭环点 */
  @Column({ name: 'delivered_receipt_id', type: 'uuid', nullable: true })
  deliveredReceiptId: string | null;

  /** 来源回执（SIGNED 事件归并而来时） */
  @Column({ name: 'source_receipt_id', type: 'uuid', nullable: true })
  sourceReceiptId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
