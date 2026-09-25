import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  DeliveryStatus,
  NotifiableStatus,
  NotifyChannel,
} from '../common/enums';
import { NotificationRecord } from './notification.entity';

/**
 * 一次投递尝试：每次投递保存不可变内容快照、稳定投递号与尝试序号。
 * 状态机：PENDING → ACCEPTED → DELIVERED / FAILED；
 * DELIVERED / FAILED 为终态，迟到/重复回执仅留痕，不再改变本尝试状态。
 */
@Entity('notification_deliveries')
@Index(['notification', 'attemptNo'], { unique: true })
export class NotificationDelivery {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => NotificationRecord, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'notification_id' })
  notification: NotificationRecord;

  /** 稳定投递号（DN-000001…），分配后不变，回执/签收均按它对账 */
  @Column({ name: 'delivery_no', type: 'varchar', length: 40, unique: true })
  deliveryNo: string;

  /** 尝试序号：同一告知记录内从 1 起递增（失败重试产生新序号） */
  @Column({ name: 'attempt_no', type: 'int' })
  attemptNo: number;

  /** 离线模拟投递通道 */
  @Column({ name: 'channel', type: 'varchar', length: 20 })
  channel: NotifyChannel;

  @Column({ name: 'status', type: 'varchar', length: 20, default: DeliveryStatus.PENDING })
  status: DeliveryStatus;

  /** 投递时刻的可告知状态快照（已确认 / 尚未确认） */
  @Column({ name: 'notifiable_status', type: 'varchar', length: 20 })
  notifiableStatus: NotifiableStatus;

  /** 投递时刻的内容版本（签收只能绑定已送达的明确版本） */
  @Column({ name: 'content_version', type: 'int' })
  contentVersion: number;

  /** 不可变内容快照：本次投递实际发出的文本，之后内容更新不影响此处 */
  @Column({ name: 'content_snapshot', type: 'text' })
  contentSnapshot: string;

  /** 快照内容指纹（sha256） */
  @Column({ name: 'content_hash', type: 'varchar', length: 64 })
  contentHash: string;

  /** 幂等键：重复投递请求按同键回放 */
  @Index('notification_deliveries_idempotency_key_key', {
    unique: true,
    where: 'idempotency_key IS NOT NULL',
  })
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128, nullable: true })
  idempotencyKey: string | null;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason: string | null;

  @Column({ name: 'accepted_at', type: 'timestamptz', nullable: true })
  acceptedAt: Date | null;

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;

  @Column({ name: 'failed_at', type: 'timestamptz', nullable: true })
  failedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
