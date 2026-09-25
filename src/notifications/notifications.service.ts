import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AssessmentCase } from '../entities/assessment-case.entity';
import { NotificationRecord } from '../entities/notification.entity';
import { NotificationContentVersion } from '../entities/notification-content-version.entity';
import {
  CaseStatus,
  NotifiableStatus,
  NotificationStatus,
} from '../common/enums';
import { buildFamilyNoticeText } from '../common/notice-text.util';
import { initialContentVersion } from '../common/content-version.util';
import { NotifyAttemptDto } from './dto/notify-attempt.dto';
import { NotifyChannelService } from './notify-channel.service';

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(AssessmentCase)
    private readonly caseRepo: Repository<AssessmentCase>,
    @InjectRepository(NotificationRecord)
    private readonly notifRepo: Repository<NotificationRecord>,
    private readonly channel: NotifyChannelService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 尝试向家属告知（旧同步通道接口，保持兼容）。两条维度分开记录、每次尝试独立成行：
   *  - notifiableStatus：CONFIRMED（等级已确认）/ UNCONFIRMED（尚未确认）
   *  - status：本次送达结果 PENDING / DELIVERED / FAILED
   * 尚未确认也允许尝试，独立落 UNCONFIRMED 记录，不影响后续复核与确认。
   * 新记录同时登记内容版本 v1，可继续走投递/回执/签收闭环。
   */
  async attempt(caseId: string, dto: NotifyAttemptDto): Promise<NotificationRecord> {
    const assessmentCase = await this.caseRepo.findOne({
      where: { id: caseId },
      relations: { scaleVersion: true, review: true },
    });
    if (!assessmentCase) throw new NotFoundException('评估案件不存在');

    const isConfirmed = assessmentCase.status === CaseStatus.CONFIRMED;
    const forceFail = dto.simulateFail === true;

    const record = new NotificationRecord();
    record.assessmentCase = assessmentCase;
    record.attempts = 1;
    record.lastAttemptAt = new Date();
    record.notifiableStatus = isConfirmed
      ? NotifiableStatus.CONFIRMED
      : NotifiableStatus.UNCONFIRMED;
    record.contentVersion = 1;
    record.message = buildFamilyNoticeText({
      elderName: assessmentCase.elderName,
      scaleTitle: assessmentCase.scaleVersion.title,
      status: assessmentCase.status,
      confirmedGrade: assessmentCase.confirmedGrade,
      reviewComment: assessmentCase.review?.comment ?? null,
      reviewerId: assessmentCase.review?.reviewerId ?? null,
    });

    const result = await this.channel.send(
      assessmentCase.familyContact,
      record.message,
      forceFail,
    );

    if (result.delivered) {
      if (isConfirmed) {
        record.status = NotificationStatus.DELIVERED;
        record.failureReason = null;
      } else {
        // 通道虽可达，但等级尚未确认：本次告知业务上记为失败，原因独立标注
        record.status = NotificationStatus.FAILED;
        record.failureReason = '等级尚未确认，无法完成有效告知（通道虽可达）';
      }
    } else {
      record.status = NotificationStatus.FAILED;
      record.failureReason = result.failureReason;
    }

    return this.dataSource.transaction(async (em) => {
      const saved = await em.getRepository(NotificationRecord).save(record);
      await em.save(
        NotificationContentVersion,
        initialContentVersion(saved, '告知创建'),
      );
      return saved;
    });
  }

  listForCase(caseId: string) {
    return this.notifRepo.find({
      where: { assessmentCase: { id: caseId } },
      order: { createdAt: 'ASC' },
    });
  }
}
