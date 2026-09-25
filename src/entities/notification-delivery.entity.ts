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
  DeliveryChannel,
  NotificationStatus,
} from '../common/enums';
import { AssessmentCase } from './assessment-case.entity';

/**
 * 投递聚合：一个稳定投递号一行，归并该投递全部尝试（含重试）的最终状态。
 * 归并规则（回执可能重复、乱序、在重试后迟到）：
 *  - 仅“最高 attemptNo 的终态尝试”决定最终状态；
 *  - 旧尝试迟到的 DELIVERED 不得覆盖更新尝试的最终状态；
 *  - ACCEPTED（已发送/渠道受理）只是中间态，永远不能被当作送达确认。
 */
@Entity('notification_deliveries')
export class NotificationDelivery {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @ManyToOne(() => AssessmentCase, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assessment_case_id' })
  assessmentCase: AssessmentCase;

  /** 稳定投递号（业务可见、全局唯一） */
  @Index({ unique: true })
  @Column({ name: 'stable_delivery_no', type: 'varchar', length: 32 })
  stableDeliveryNo: string;

  /** 归属锚点告知（内容版本） */
  @Index()
  @Column({ name: 'anchor_notification_id', type: 'uuid' })
  anchorNotificationId: string;

  /** 投递内容版本号 */
  @Column({ name: 'content_version', type: 'int' })
  contentVersion: number;

  /** 投递内容哈希（与各次尝试快照一致） */
  @Column({ name: 'content_hash', type: 'varchar', length: 64 })
  contentHash: string;

  /** 最新一次尝试使用的渠道（仅信息性；每次尝试渠道记录在 attempt 行） */
  @Column({ name: 'last_channel', type: 'varchar', length: 16, nullable: true })
  lastChannel: DeliveryChannel | null;

  /** 已创建的尝试总数 */
  @Column({ name: 'attempt_count', type: 'int', default: 0 })
  attemptCount: number;

  /**
   * 聚合最终状态：PENDING / ACCEPTED / DELIVERED / FAILED。
   * 取最高 attemptNo 的终态；最高序号尚无终态则保留 ACCEPTED/PENDING。
   */
  @Column({ name: 'aggregate_status', type: 'varchar', length: 20 })
  aggregateStatus: NotificationStatus;

  /** 决定聚合状态的尝试序号（null=尚无尝试终态） */
  @Column({ name: 'winning_attempt_no', type: 'int', nullable: true })
  winningAttemptNo: number | null;

  /** 最新失败原因（仅信息性；每次尝试的原因保留在 attempt 行/回执中） */
  @Column({ name: 'last_failure_reason', type: 'text', nullable: true })
  lastFailureReason: string | null;

  /** 聚合状态对应的最近时间 */
  @Column({ name: 'aggregate_at', type: 'timestamptz', nullable: true })
  aggregateAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
