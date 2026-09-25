import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { SignatureStatus } from '../common/enums';
import { NotificationRecord } from './notification.entity';
import { NotificationDelivery } from './notification-delivery.entity';

/**
 * 家属签收记录：只能绑定“已送达尝试所携带的明确内容版本”。
 * 同一投递至多一条签收（重复签收幂等回放，不新增结果）；
 * 内容被新版本替代后，旧版迟到签收以 SUPERSEDED 留痕、不生效。
 */
@Entity('notification_signatures')
export class NotificationSignature {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => NotificationRecord, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'notification_id' })
  notification: NotificationRecord;

  @Index({ unique: true })
  @ManyToOne(() => NotificationDelivery, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'delivery_id' })
  delivery: NotificationDelivery;

  /** 幂等键：与回执事件共用同一事件空间 */
  @Column({ name: 'event_id', type: 'varchar', length: 128, unique: true })
  eventId: string;

  @Column({ name: 'delivery_no', type: 'varchar', length: 40 })
  deliveryNo: string;

  @Column({ name: 'attempt_no', type: 'int' })
  attemptNo: number;

  /** 签收绑定的内容版本与内容指纹（来自被签收投递的不可变快照） */
  @Index()
  @Column({ name: 'content_version', type: 'int' })
  contentVersion: number;

  @Column({ name: 'content_hash', type: 'varchar', length: 64 })
  contentHash: string;

  @Column({ name: 'signer', type: 'varchar', length: 100 })
  signer: string;

  @Column({ name: 'status', type: 'varchar', length: 20 })
  status: SignatureStatus;

  /** 家属签收时间（调用方提供，默认取服务端时间） */
  @Column({ name: 'signed_at', type: 'timestamptz' })
  signedAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
