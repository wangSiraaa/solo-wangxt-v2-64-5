import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { NotificationRecord } from './notification.entity';

/**
 * 告知内容版本登记：每次内容替代产生新版本（旧版本内容永久保留）。
 * 投递快照引用版本号；签收只能绑定已送达的明确版本，
 * 旧版本的迟到签收仅留痕（SUPERSEDED）。
 */
@Entity('notification_content_versions')
@Index(['notification', 'version'], { unique: true })
export class NotificationContentVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => NotificationRecord, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'notification_id' })
  notification: NotificationRecord;

  @Column({ name: 'version', type: 'int' })
  version: number;

  /** 该版本的完整内容（不可变） */
  @Column({ name: 'content', type: 'text' })
  content: string;

  @Column({ name: 'content_hash', type: 'varchar', length: 64 })
  contentHash: string;

  /** 版本产生原因（告知创建 / 内容刷新等） */
  @Column({ name: 'reason', type: 'varchar', length: 200, nullable: true })
  reason: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
