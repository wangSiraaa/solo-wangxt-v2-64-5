import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AssessmentCase } from '../entities/assessment-case.entity';
import { AssessorAnswer } from '../entities/assessor-answer.entity';
import { ScaleVersion } from '../entities/scale-version.entity';
import { ScaleItem } from '../entities/scale-item.entity';
import { ScaleOption } from '../entities/scale-option.entity';
import { ReviewDecision } from '../entities/review-decision.entity';
import { CaseStatus, ReviewResult } from '../common/enums';
import { ScoringService } from '../scoring/scoring.service';
import { SubmitAssessmentDto } from './dto/submit-assessment.dto';
import { createAnchorNotice } from '../notifications/notice-factory';
import { agreementNoticeText } from '../notifications/notice-content.util';

@Injectable()
export class AssessmentsService {
  constructor(
    @InjectRepository(AssessmentCase)
    private readonly caseRepo: Repository<AssessmentCase>,
    @InjectRepository(ScaleVersion)
    private readonly scaleRepo: Repository<ScaleVersion>,
    private readonly scoring: ScoringService,
    private readonly dataSource: DataSource,
  ) {}

  async submit(dto: SubmitAssessmentDto): Promise<AssessmentCase> {
    // 必须恰好是评估员 1 和 2
    const ids = dto.assessors.map((a) => a.assessorId).sort();
    if (ids[0] !== 1 || ids[1] !== 2) {
      throw new BadRequestException({
        code: 'ASSESSORS_MUST_BE_1_AND_2',
        message: '必须同时提交评估员 1 与评估员 2 的作答',
      });
    }
    for (const a of dto.assessors) {
      const codes = a.answers.map((x) => x.itemCode);
      if (new Set(codes).size !== codes.length) {
        throw new BadRequestException({
          code: 'DUPLICATE_ITEM_ANSWER',
          message: `评估员 ${a.assessorId} 对同一条目存在重复作答`,
        });
      }
    }

    const scale = dto.scaleVersionId
      ? await this.scaleRepo.findOne({ where: { id: dto.scaleVersionId } })
      : await this.scaleRepo.findOne({
          where: { code: 'DEMO_ADL' },
          order: { publishedAt: 'DESC' },
        });
    if (!scale) throw new NotFoundException('量表版本不存在');

    const [items, options] = await Promise.all([
      this.dataSource.getRepository(ScaleItem).find({
        where: { scaleVersion: { id: scale.id } },
      }),
      this.dataSource.getRepository(ScaleOption).find({
        where: { scaleVersion: { id: scale.id } },
        relations: { item: true },
      }),
    ]);

    const [a1, a2] = [
      dto.assessors.find((x) => x.assessorId === 1)!,
      dto.assessors.find((x) => x.assessorId === 2)!,
    ];

    const itemCodes = new Set(items.map((i) => i.code));
    for (const a of [a1, a2]) {
      const unknownItem = a.answers.find((x) => !itemCodes.has(x.itemCode));
      if (unknownItem) {
        throw new BadRequestException({
          code: 'UNKNOWN_SCALE_ITEM',
          message: `条目 ${unknownItem.itemCode} 不属于量表版本 ${scale.code}@${scale.version}`,
        });
      }
      // 选项是否合法（含不允许 NA 的题选了 NA）交由评分逻辑处理：
      // 该类作答按“无效必填项”处理 → 案件 INCOMPLETE，而非 400
    }

    const r1 = this.scoring.score(scale, items, options, a1.answers);
    const r2 = this.scoring.score(scale, items, options, a2.answers);

    const savedId = await this.dataSource.transaction(async (em) => {
      const entity = new AssessmentCase();
      entity.elderId = dto.elderId;
      entity.elderName = dto.elderName;
      entity.familyContact = dto.familyContact;
      entity.scaleVersion = scale;
      entity.assessor1Details = r1;
      entity.assessor2Details = r2;

      const answerRows: AssessorAnswer[] = [];
      for (const [assessorId, result, raw] of [
        [1, r1, a1.answers],
        [2, r2, a2.answers],
      ] as const) {
        for (const ans of raw) {
          const line = result.lines.find((l) => l.itemCode === ans.itemCode)!;
          if (line.optionCode === null) continue; // 缺失项不落作答行
          const row = new AssessorAnswer();
          row.assessorId = assessorId;
          row.itemCode = ans.itemCode;
          row.optionCode = ans.optionCode;
          row.score = line.score;
          row.na = line.na;
          answerRows.push(row);
        }
      }

      // 任一人不可定级 → 案件 INCOMPLETE，不得自动定级
      if (!r1.gradeable || !r2.gradeable) {
        entity.status = CaseStatus.INCOMPLETE;
        entity.conflicting = false;
      } else {
        entity.assessor1RawScore = r1.rawScore;
        entity.assessor1MaxScore = r1.maxScore;
        entity.assessor1ScorePct = r1.scorePct;
        entity.assessor1Grade = r1.grade;
        entity.assessor2RawScore = r2.rawScore;
        entity.assessor2MaxScore = r2.maxScore;
        entity.assessor2ScorePct = r2.scorePct;
        entity.assessor2Grade = r2.grade;

        const conflict = r1.grade !== r2.grade;
        entity.conflicting = conflict;

        if (conflict) {
          // 冲突 → 进入管理复核，绝不简单取较高等级
          entity.status = CaseStatus.PENDING_REVIEW;
        } else {
          // 一致 → 系统确认，等级确认后生成告知记录
          entity.status = CaseStatus.CONFIRMED;
          entity.confirmedGrade = r1.grade;

          const review = new ReviewDecision();
          review.assessmentCase = entity;
          review.result = ReviewResult.AGREEMENT;
          review.confirmedGrade = r1.grade!;
          review.reviewerId = 'SYSTEM';
          review.comment =
            `两位评估员等级一致（${r1.grade}）：系统自动确认。` +
            `评估员1 得分 ${r1.rawScore}/${r1.maxScore}（${r1.scorePct}%），` +
            `评估员2 得分 ${r2.rawScore}/${r2.maxScore}（${r2.scorePct}%）。`;
          review.idempotencyKey = null;

          entity.answers = answerRows;
          const saved = await em.save(entity);
          saved.scaleVersion = scale;
          review.assessmentCase = saved;
          await em.save(review);

          await createAnchorNotice({
            em,
            assessmentCase: saved,
            message: this.buildNoticeText(
              dto.elderName,
              scale.title,
              r1.grade!,
              review.comment,
            ),
            source: 'AGREEMENT',
          });

          return saved.id;
        }
      }

      entity.answers = answerRows;
      const saved = await em.save(entity);
      return saved.id;
    });
    return this.findOne(savedId);
  }

  async findOne(id: string): Promise<AssessmentCase> {
    const c = await this.caseRepo.findOne({
      where: { id },
      relations: {
        scaleVersion: true,
        answers: true,
        review: true,
        notifications: true,
      },
      order: {
        notifications: { createdAt: 'ASC' },
        answers: { assessorId: 'ASC', itemCode: 'ASC' },
      },
    });
    if (!c) throw new NotFoundException('评估案件不存在');
    return c;
  }

  private buildNoticeText(
    elderName: string,
    scaleTitle: string,
    grade: string,
    basis: string,
  ): string {
    return agreementNoticeText(elderName, scaleTitle, grade, basis);
  }
}
