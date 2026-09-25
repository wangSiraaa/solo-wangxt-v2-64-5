import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { AssessmentCase } from '../entities/assessment-case.entity';
import { ReviewDecision } from '../entities/review-decision.entity';
import { CaseStatus, ReviewResult } from '../common/enums';
import { ConfirmReviewDto } from './dto/confirm-review.dto';
import { createAnchorNotice } from '../notifications/notice-factory';
import { reviewNoticeText } from '../notifications/notice-content.util';

@Injectable()
export class ReviewsService {
  constructor(
    @InjectRepository(AssessmentCase)
    private readonly caseRepo: Repository<AssessmentCase>,
    @InjectRepository(ReviewDecision)
    private readonly reviewRepo: Repository<ReviewDecision>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 管理复核确认。冲突案件不会自动取较高等级：
   * 管理员必须在两位评估员的候选等级中显式选择，并留下复核意见。
   * 重复确认请求：带相同幂等键 → 回放首次结果；不带/不同键 → 409。
   */
  async confirm(caseId: string, dto: ConfirmReviewDto) {
    const assessmentCase = await this.caseRepo.findOne({
      where: { id: caseId },
      relations: { review: true, notifications: true, scaleVersion: true },
    });
    if (!assessmentCase) throw new NotFoundException('评估案件不存在');

    if (assessmentCase.status === CaseStatus.CONFIRMED) {
      if (
        dto.idempotencyKey &&
        assessmentCase.review?.idempotencyKey === dto.idempotencyKey
      ) {
        return {
          replayed: true,
          message: '重复确认请求已幂等回放，未产生第二次确认',
          case: await this.caseRepo.findOne({
            where: { id: caseId },
            relations: { review: true, notifications: true },
          }),
        };
      }
      throw new ConflictException({
        code: 'CASE_ALREADY_CONFIRMED',
        message: `案件已确认为 ${assessmentCase.confirmedGrade}，不得重复确认`,
      });
    }

    if (assessmentCase.status === CaseStatus.INCOMPLETE) {
      throw new ConflictException({
        code: 'CASE_NOT_GRADEABLE',
        message: '必填项缺失，未自动定级；请先补充评估后再复核',
      });
    }

    // PENDING_REVIEW：最终等级必须是两位评估员候选之一
    const candidates = [
      assessmentCase.assessor1Grade,
      assessmentCase.assessor2Grade,
    ];
    if (!candidates.includes(dto.confirmedGrade)) {
      throw new BadRequestException({
        code: 'GRADE_NOT_IN_CANDIDATES',
        message: `复核等级必须取自两位评估员结果 ${candidates.join('/')}，不得另行指定或自动取高`,
      });
    }

    try {
      return await this.dataSource.transaction(async (em) => {
        assessmentCase.status = CaseStatus.CONFIRMED;
        assessmentCase.confirmedGrade = dto.confirmedGrade;
        await em.save(assessmentCase);

        const review = new ReviewDecision();
        review.assessmentCase = assessmentCase;
        review.result = ReviewResult.CONFIRMED;
        review.confirmedGrade = dto.confirmedGrade;
        review.reviewerId = dto.reviewerId;
        review.comment = dto.comment;
        review.idempotencyKey = dto.idempotencyKey ?? null;
        await em.save(review);

        // 等级确认后生成锚点告知（内容版本 1，PENDING 待送达）
        await createAnchorNotice({
          em,
          assessmentCase,
          message: reviewNoticeText(
            assessmentCase.elderName,
            assessmentCase.scaleVersion.title,
            dto.confirmedGrade,
            dto.comment,
          ),
          source: 'REVIEW',
        });

        return {
          replayed: false,
          case: await em.findOne(AssessmentCase, {
            where: { id: caseId },
            relations: { review: true, notifications: true },
          }),
        };
      });
    } catch (e: any) {
      // 并发下幂等键唯一约束：回放已有确认
      if (e?.constraint === 'review_decisions_idempotency_key_key' || /idempotency_key/.test(String(e?.detail ?? ''))) {
        const existing = await this.reviewRepo.findOne({
          where: { idempotencyKey: dto.idempotencyKey ?? IsNull() },
        });
        if (existing) {
          return {
            replayed: true,
            message: '并发重复确认请求已幂等回放',
            case: await this.caseRepo.findOne({
              where: { id: caseId },
              relations: { review: true, notifications: true },
            }),
          };
        }
      }
      throw e;
    }
  }
}
