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
  NotifiableStatus,
  NotificationStatus,
} from '../common/enums';
import { AssessmentCase } from './assessment-case.entity';

/** 家属告知记录：送达失败与尚未确认分别独立记录状态 */
@Entity('notification_records')
export class NotificationRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @ManyToOne(() => AssessmentCase, (c) => c.notifications, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assessment_case_id' })
  assessmentCase: AssessmentCase;

  @Column({ name: 'status', type: 'varchar', length: 20, default: NotificationStatus.PENDING })
  status: NotificationStatus;

  /** 告知对象的可告知状态：已确认 / 尚未确认（与送达结果分开记录） */
  @Column({ name: 'notifiable_status', type: 'varchar', length: 20 })
  notifiableStatus: NotifiableStatus;

  @Column({ name: 'message', type: 'text', nullable: true })
  message: string | null;

  /** 当前内容版本号：内容被新版本替代时 +1；投递快照与签收均绑定版本 */
  @Column({ name: 'content_version', type: 'int', default: 1 })
  contentVersion: number;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason: string | null;

  @Column({ name: 'attempts', type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'last_attempt_at', type: 'timestamptz', nullable: true })
  lastAttemptAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
