import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ReceiptEvent } from '../common/enums';
import { NotificationDelivery } from './notification-delivery.entity';

/**
 * 投递器异步回传回执：只追加（append-only）、不可变。
 * 回执可能重复（同 receiptEventId 唯一约束天然去重）、乱序、在重试后迟到；
 * 是否影响最终状态由投递状态机按 stableDeliveryNo + attemptNo 归并判断，
 * 原始回执永远完整保留作为证据。
 */
@Entity('notification_receipts')
export class NotificationReceipt {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 回执携带的稳定投递号（不存在 → 404，不产生状态） */
  @Index()
  @Column({ name: 'stable_delivery_no', type: 'varchar', length: 32 })
  stableDeliveryNo: string;

  /** 回执针对的尝试序号；缺失时按投递器语义补 1（同号仅一次尝试的兼容回传） */
  @Column({ name: 'attempt_no', type: 'int' })
  attemptNo: number;

  /** 渠道回传的幂等事件号：重复回传不新增结果 */
  @Index({ unique: true })
  @Column({ name: 'receipt_event_id', type: 'varchar', length: 128 })
  receiptEventId: string;

  @Column({ name: 'event', type: 'varchar', length: 16 })
  event: ReceiptEvent;

  @Column({ name: 'channel', type: 'varchar', length: 16, nullable: true })
  channel: string | null;

  /** 失败原因（FAILED 事件） */
  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason: string | null;

  /** 渠道声称的事件发生时间（可迟到、可乱序；仅留痕） */
  @Column({ name: 'occurred_at', type: 'timestamptz', nullable: true })
  occurredAt: Date | null;

  /** 归并时该回执是否实际改变了聚合状态（旧尝试迟到/重复均为 false，便于证据解释） */
  @Column({ name: 'changed_aggregate', type: 'boolean', default: false })
  changedAggregate: boolean;

  /** 归并说明（如“旧尝试迟到，不覆盖新尝试最终状态”） */
  @Column({ name: 'merge_note', type: 'text', nullable: true })
  mergeNote: string | null;

  /** 原始回执负载（jsonb，完整留痕） */
  @Column({ name: 'raw_payload', type: 'jsonb', nullable: true })
  rawPayload: unknown | null;

  @ManyToOne(() => NotificationDelivery, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'delivery_id' })
  delivery: NotificationDelivery;

  @Column({ name: 'delivery_id', type: 'uuid' })
  deliveryId: string;

  @CreateDateColumn({ name: 'received_at' })
  receivedAt: Date;
}
