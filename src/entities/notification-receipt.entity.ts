import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ReceiptType } from '../common/enums';
import { NotificationDelivery } from './notification-delivery.entity';

/**
 * 投递器回执（append-only 事件日志）。
 * 回执可能重复、乱序或在重试后迟到：
 *  - event_id 唯一约束保证同一事件幂等（重复回执不新增结果）；
 *  - applied=false 的记录为“已收到但未改变状态”的留痕（终态后迟到、旧尝试回执等）。
 */
@Entity('notification_receipts')
export class NotificationReceipt {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => NotificationDelivery, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'delivery_id' })
  delivery: NotificationDelivery;

  /** 投递器事件 ID：幂等键，重复回传按首次结果回放 */
  @Column({ name: 'event_id', type: 'varchar', length: 128, unique: true })
  eventId: string;

  /** 冗余投递号/尝试序号，便于不按关联查询也能对账 */
  @Index()
  @Column({ name: 'delivery_no', type: 'varchar', length: 40 })
  deliveryNo: string;

  @Column({ name: 'attempt_no', type: 'int' })
  attemptNo: number;

  @Column({ name: 'type', type: 'varchar', length: 20 })
  type: ReceiptType;

  /** 投递器声称的事件发生时间（可能早于到达时间=迟到回执） */
  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;

  /** 失败原因等附加说明 */
  @Column({ name: 'reason', type: 'text', nullable: true })
  reason: string | null;

  /** 签收人（type=SIGNED 时） */
  @Column({ name: 'signer', type: 'varchar', length: 100, nullable: true })
  signer: string | null;

  /** 是否被状态机接受并产生效果（false=重复/迟到/无效，仅留痕） */
  @Column({ name: 'applied', type: 'boolean', default: false })
  applied: boolean;

  /** 归并说明（为何未生效、生效为何种转移） */
  @Column({ name: 'note', type: 'text', nullable: true })
  note: string | null;

  /** 原始回执报文（审计） */
  @Column({ name: 'payload', type: 'jsonb', nullable: true })
  payload: unknown | null;

  @Index()
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
