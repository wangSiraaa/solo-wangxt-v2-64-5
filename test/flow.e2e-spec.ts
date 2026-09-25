import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { GradeCode } from '../src/common/enums';

/**
 * 全流程 e2e：
 * 必填缺失不定级 / NA 分母按量表定义 / 双评估员冲突进复核不取高 /
 * 告知失败与尚未确认分别记录 / 费用独立生效 / 月中升级 / 闰月天数 /
 * 重复确认请求 / 同日重叠生效拦截 / 评分来源与费用分段可解释
 */
describe('养老评估-复核-告知-费用 全流程 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let conflictCaseId: string;

  const ITEMS_8 = [
    'TRANSFER',
    'WALKING',
    'BATHING',
    'DRESSING',
    'TOILETING',
    'EATING',
    'CONTINENCE',
    'GROOMING',
  ];
  const OPT = {
    INDEPENDENT: 'INDEPENDENT',
    SOME_HELP: 'SOME_HELP',
    MUCH_HELP: 'MUCH_HELP',
    TOTAL_DEP: 'TOTAL_DEP',
    NA: 'NA',
  };

  /** 构造 10 条答案（含 STAIRS/OUTDOOR 两个可 NA 项） */
  function answers(
    override: Record<string, string> = {},
    omit: string[] = [],
  ) {
    const map: Record<string, string> = {};
    for (const code of ITEMS_8) map[code] = OPT.INDEPENDENT;
    map.STAIRS = OPT.INDEPENDENT;
    map.OUTDOOR = OPT.INDEPENDENT;
    Object.assign(map, override);
    return Object.entries(map)
      .filter(([code]) => !omit.includes(code))
      .map(([itemCode, optionCode]) => ({ itemCode, optionCode }));
  }

  function payload(
    elderId: string,
    a1: ReturnType<typeof answers>,
    a2: ReturnType<typeof answers>,
    familyContact = '13800000000',
  ) {
    return {
      elderId,
      elderName: `老人${elderId}`,
      familyContact,
      assessors: [
        { assessorId: 1, answers: a1 },
        { assessorId: 2, answers: a2 },
      ],
    };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.setGlobalPrefix('api');
    await app.init();
    http = request(app.getHttpServer());
    // 清空业务表（保留量表与日费规则种子）
    const ds = app.get(DataSource);
    await ds.query(`
      TRUNCATE grade_periods, notification_signoffs, notification_receipts,
               notification_deliveries, notification_records, review_decisions,
               assessor_answers, assessment_cases RESTART IDENTITY CASCADE
    `);
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  // ---------------------------------------------------------------------------
  it('必填项缺失：两位评估员都不得自动定级，案件 INCOMPLETE 且无确认等级', async () => {
    const res = await http
      .post('/api/assessments')
      .send(
        payload(
          'E-MISS',
          answers({}, ['BATHING']), // 必填项洗澡缺失
          answers({}, ['EATING']),
        ),
      )
      .expect(201);

    expect(res.body.status).toBe('INCOMPLETE');
    expect(res.body.confirmedGrade).toBeNull();
    expect(res.body.conflicting).toBe(false);

    const d1 = res.body.assessor1Details;
    const d2 = res.body.assessor2Details;
    expect(d1.gradeable).toBe(false);
    expect(d1.grade).toBeNull();
    expect(d1.missingRequired.map((x: any) => x.itemCode)).toContain('BATHING');
    expect(d2.missingRequired.map((x: any) => x.itemCode)).toContain('EATING');
    // 逐项解释中标注缺失原因
    const bathingLine = d1.lines.find((l: any) => l.itemCode === 'BATHING');
    expect(bathingLine.optionCode).toBeNull();
    expect(bathingLine.note).toContain('必填项缺失');
  });

  it('INCOMPLETE 案件尝试复核/生效均被拒绝', async () => {
    const created = await http
      .post('/api/assessments')
      .send(payload('E-MISS2', answers({}, ['DRESSING']), answers({})))
      .expect(201);

    await http
      .post(`/api/assessments/${created.body.id}/review/confirm`)
      .send({
        confirmedGrade: GradeCode.LIGHT,
        reviewerId: 'mgr1',
        comment: '不应允许确认未定级案件',
      })
      .expect(409)
      .expect((r) =>
        expect(r.body.message.code ?? r.body.message).toBeTruthy(),
      );

    await http
      .post('/api/fees/activate')
      .send({ caseId: created.body.id, effectiveDate: '2024-01-01' })
      .expect(409);
  });

  it('NA 按量表定义从分母剔除：评分来源可解释（含 NA 时等级随有效分母变化）', async () => {
    // 7 项 TOTAL_DEP + STAIRS NA + OUTDOOR NA
    const override: Record<string, string> = {};
    for (const code of ITEMS_8) override[code] = OPT.TOTAL_DEP;
    override.STAIRS = OPT.NA;
    override.OUTDOOR = OPT.NA;

    const res = await http
      .post('/api/assessments')
      .send(payload('E-NA', answers(override), answers(override)))
      .expect(201);

    const d = res.body.assessor1Details;
    expect(d.gradeable).toBe(true);
    expect(d.rawScore).toBe(24);
    expect(d.denominator).toBe(8); // 2 个 NA 项从分母剔除
    expect(d.maxScore).toBe(24);
    expect(d.naCount).toBe(2);
    expect(Number(d.scorePct)).toBeCloseTo(100, 5);
    expect(d.grade).toBe(GradeCode.SEVERE);
    const naLine = d.lines.find((l: any) => l.itemCode === 'STAIRS');
    expect(naLine.na).toBe(true);
    expect(naLine.includedInDenominator).toBe(false);
    expect(naLine.note).toContain('从分母剔除');
  });

  it('非允许 NA 的条目选 NA 视为无效作答：必填项不定级', async () => {
    const res = await http
      .post('/api/assessments')
      .send(
        payload(
          'E-NABAD',
          answers({ BATHING: OPT.NA }),
          answers({ BATHING: OPT.NA }),
        ),
      )
      .expect(201);
    expect(res.body.status).toBe('INCOMPLETE');
    const line = res.body.assessor1Details.lines.find(
      (l: any) => l.itemCode === 'BATHING',
    );
    expect(line.note).toContain('量表未定义');
  });

  it('两位评估员等级一致：系统确认并自动生成待送达告知（PENDING）', async () => {
    const res = await http
      .post('/api/assessments')
      .send(payload('E-AGREE', answers({}), answers({})))
      .expect(201);

    expect(res.body.status).toBe('CONFIRMED');
    expect(res.body.confirmedGrade).toBe(GradeCode.LIGHT);
    expect(res.body.review.result).toBe('AGREEMENT');
    expect(res.body.review.reviewerId).toBe('SYSTEM');
    // 确认后即生成告知记录：已确认可告知，但尚未送达
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0].status).toBe('PENDING');
    expect(res.body.notifications[0].notifiableStatus).toBe('CONFIRMED');
  });

  it('冲突：LIGHT vs SEVERE 进入复核，绝不自动取较高等级', async () => {
    const light = answers({ EATING: OPT.SOME_HELP }); // 1/30 = 3.33% LIGHT
    const severe = (() => {
      const o: Record<string, string> = {};
      for (const code of ITEMS_8) o[code] = OPT.TOTAL_DEP;
      o.STAIRS = OPT.TOTAL_DEP; // 27/30 = 90% SEVERE（OUTDOOR 独立）
      return answers(o);
    })();

    const res = await http
      .post('/api/assessments')
      .send(payload('E-CONFLICT', light, severe))
      .expect(201);

    expect(res.body.status).toBe('PENDING_REVIEW');
    expect(res.body.conflicting).toBe(true);
    expect(res.body.assessor1Grade).toBe(GradeCode.LIGHT);
    expect(res.body.assessor2Grade).toBe(GradeCode.SEVERE);
    expect(res.body.confirmedGrade).toBeNull();
    expect(res.body.review).toBeNull();
    expect(res.body.notifications).toHaveLength(0); // 未确认不生成确认告知
    conflictCaseId = res.body.id;
  });

  it('复核：候选外等级被拒（不得折中/自动取高）；未确认不得费用生效', async () => {
    // 候选外：两评估员给的是 LIGHT / SEVERE，MODERATE 不在候选内
    await http
      .post(`/api/assessments/${conflictCaseId}/review/confirm`)
      .send({
        confirmedGrade: GradeCode.MODERATE,
        reviewerId: 'mgr1',
        comment: '折中取中度',
      })
      .expect(400);

    // 冲突案件未确认时即尝试费用生效 → 拒绝
    await http
      .post('/api/fees/activate')
      .send({ caseId: conflictCaseId, effectiveDate: '2024-02-01' })
      .expect(409);
  });

  it('复核：管理员显式选择较低候选 LIGHT 并留意见（证明非简单取高）', async () => {
    const res = await http
      .post(`/api/assessments/${conflictCaseId}/review/confirm`)
      .send({
        confirmedGrade: GradeCode.LIGHT,
        reviewerId: 'mgr-wang',
        comment: '复核录像与生活记录，评定为轻度（评估员2对多项理解有偏差）',
      })
      .expect(201);

    expect(res.body.replayed).toBe(false);
    expect(res.body.case.status).toBe('CONFIRMED');
    expect(res.body.case.confirmedGrade).toBe(GradeCode.LIGHT);
    expect(res.body.case.review.result).toBe('CONFIRMED');
    expect(res.body.case.review.comment).toContain('评定为轻度');
    // 确认后生成告知 PENDING
    const notif = res.body.case.notifications[0];
    expect(notif.status).toBe('PENDING');
    expect(notif.notifiableStatus).toBe('CONFIRMED');
  });

  it('重复确认请求：相同幂等键回放；无幂等键重复确认 409', async () => {
    // 再造一个冲突案件
    const conflict = await http
      .post('/api/assessments')
      .send(
        payload(
          'E-DUP',
          answers({}),
          (() => {
            const o: Record<string, string> = {};
            for (const c of ITEMS_8) o[c] = OPT.TOTAL_DEP;
            return answers(o);
          })(),
        ),
      )
      .expect(201);
    expect(conflict.body.status).toBe('PENDING_REVIEW');
    const id = conflict.body.id;

    const body = {
      confirmedGrade: GradeCode.SEVERE,
      reviewerId: 'mgr2',
      comment: '复核确认重度',
      idempotencyKey: 'idem-001',
    };
    const first = await http
      .post(`/api/assessments/${id}/review/confirm`)
      .send(body)
      .expect(201);
    expect(first.body.replayed).toBe(false);

    const again = await http
      .post(`/api/assessments/${id}/review/confirm`)
      .send(body)
      .expect(201);
    expect(again.body.replayed).toBe(true);

    // 不带幂等键（或不同键）的重复确认 → 409
    const noKey = await http
      .post(`/api/assessments/${id}/review/confirm`)
      .send({
        confirmedGrade: GradeCode.SEVERE,
        reviewerId: 'mgr2',
        comment: '不带幂等键的再次确认',
      })
      .expect(409);
    expect(JSON.stringify(noKey.body)).toContain('不得重复确认');
  });

  it('告知：尚未确认案件的尝试独立记录为 UNCONFIRMED/FAILED', async () => {
    const pending = await http
      .post('/api/assessments')
      .send(
        payload(
          'E-NOTIFY-UNCONFIRMED',
          answers({}),
          (() => {
            const o: Record<string, string> = {};
            for (const c of ITEMS_8) o[c] = OPT.TOTAL_DEP;
            return answers(o);
          })(),
          '13800000001',
        ),
      )
      .expect(201);
    expect(pending.body.status).toBe('PENDING_REVIEW');

    const attempt = await http
      .post(`/api/assessments/${pending.body.id}/notification/attempt`)
      .send({})
      .expect(201);
    expect(attempt.body.notifiableStatus).toBe('UNCONFIRMED');
    expect(attempt.body.status).toBe('FAILED');
    expect(attempt.body.failureReason).toContain('尚未确认');
  });

  it('告知：送达失败独立记录 FAILED + 原因；重试成功后两条记录都保留', async () => {
    // 一致确认案件，家属联系方式以 -FAIL 结尾 → 通道失败
    const c = await http
      .post('/api/assessments')
      .send(payload('E-NOTIFY-FAIL', answers({}), answers({}), '138-FAIL'))
      .expect(201);
    const id = c.body.id;

    // 确认时自动生成的 PENDING 记录存在；第一次尝试失败 → 新行
    const fail1 = await http
      .post(`/api/assessments/${id}/notification/attempt`)
      .send({})
      .expect(201);
    expect(fail1.body.status).toBe('FAILED');
    expect(fail1.body.notifiableStatus).toBe('CONFIRMED');
    expect(fail1.body.failureReason).toContain('号码无效');

    const fail2 = await http
      .post(`/api/assessments/${id}/notification/attempt`)
      .send({ simulateFail: true })
      .expect(201);
    expect(fail2.body.status).toBe('FAILED');
    expect(fail2.body.failureReason).toContain('网关超时');
    expect(fail2.body.id).not.toBe(fail1.body.id); // 失败历史各自成行

    const list = await http
      .get(`/api/assessments/${id}/notification`)
      .expect(200);
    // 1 条自动 PENDING + 2 条失败尝试
    expect(list.body).toHaveLength(3);
    expect(list.body.filter((n: any) => n.status === 'FAILED')).toHaveLength(2);

    // 送达成功与告知结果、费用生效完全独立：成功与否都不影响费用接口
    const okCase = await http
      .post('/api/assessments')
      .send(payload('E-NOTIFY-OK', answers({}), answers({}), '13900000000'))
      .expect(201);
    const delivered = await http
      .post(`/api/assessments/${okCase.body.id}/notification/attempt`)
      .send({})
      .expect(201);
    expect(delivered.body.status).toBe('DELIVERED');
  });

  // ---------------------------------------------------------------------------
  // 费用：月中升级 + 闰月天数 + 同日重叠拦截
  // ---------------------------------------------------------------------------
  let lightCaseId: string;
  let severeCaseId: string;

  it('费用：月中升级——旧区间截至前一日，新区间接续，同日不重叠', async () => {
    // 1) 轻度案件，2024-01-01 生效
    const light = await http
      .post('/api/assessments')
      .send(payload('E-FEE', answers({}), answers({})))
      .expect(201);
    lightCaseId = light.body.id;
    await http
      .post('/api/fees/activate')
      .send({ caseId: lightCaseId, effectiveDate: '2024-01-01' })
      .expect(201)
      .expect((r) => expect(r.body.replayed).toBe(false));

    // 2) 重度案件（复核确认），2024-02-15 月中升级
    const severe = await http
      .post('/api/assessments')
      .send(
        payload(
          'E-FEE',
          answers({}),
          (() => {
            const o: Record<string, string> = {};
            for (const c of ITEMS_8) o[c] = OPT.TOTAL_DEP;
            return answers(o);
          })(),
        ),
      )
      .expect(201);
    expect(severe.body.status).toBe('PENDING_REVIEW');
    severeCaseId = severe.body.id;
    await http
      .post(`/api/assessments/${severeCaseId}/review/confirm`)
      .send({
        confirmedGrade: GradeCode.SEVERE,
        reviewerId: 'mgr3',
        comment: '复核确认重度，月中调整',
      })
      .expect(201);

    const upgrade = await http
      .post('/api/fees/activate')
      .send({ caseId: severeCaseId, effectiveDate: '2024-02-15' })
      .expect(201);
    expect(upgrade.body.period.grade).toBe(GradeCode.SEVERE);
    expect(upgrade.body.period.startDate).toBe('2024-02-15');

    // 重复生效请求（同案同日同等级）→ 幂等回放
    const replay = await http
      .post('/api/fees/activate')
      .send({ caseId: severeCaseId, effectiveDate: '2024-02-15' })
      .expect(201);
    expect(replay.body.replayed).toBe(true);
  });

  it('费用：同一天不得出现重叠生效等级（另案同日不同等级 → 409，DB 约束兜底）', async () => {
    // E-FEE 老人在 2024-02-15 当天已随升级为 SEVERE；再用其轻度案件在同日生效 → 重叠
    const overlap = await http
      .post('/api/fees/activate')
      .send({ caseId: lightCaseId, effectiveDate: '2024-02-15' })
      .expect(409);
    expect(JSON.stringify(overlap.body)).toMatch(/重叠|OVERLAP/);

    // 同一天对同一老人再走一个已确认案件同样拦截（服务层 + gist 约束双保险）
    const another = await http
      .post('/api/assessments')
      .send(payload('E-FEE', answers({}), answers({}), '13700000000'))
      .expect(201);
    expect(another.body.confirmedGrade).toBe(GradeCode.LIGHT);
    const sameDay = await http
      .post('/api/fees/activate')
      .send({ caseId: another.body.id, effectiveDate: '2024-02-15' })
      .expect(409);
    expect(JSON.stringify(sameDay.body)).toMatch(/重叠|OVERLAP/);
  });

  it('费用：闰月分段——2024-02 共 29 天，1~14 轻度、15~29 重度，decimal 合计 5900.00', async () => {
    const res = await http
      .get('/api/fees/segments')
      .query({ elderId: 'E-FEE', from: '2024-02-01', to: '2024-02-29' })
      .expect(200);

    expect(res.body.totalDays).toBe(29);
    expect(res.body.segments).toHaveLength(2);
    const [s1, s2] = res.body.segments;
    expect(s1.grade).toBe(GradeCode.LIGHT);
    expect(s1.startDate).toBe('2024-02-01');
    expect(s1.endDate).toBe('2024-02-14');
    expect(s1.days).toBe(14);
    expect(s1.dailyRate).toBe('100.00');
    expect(s1.amount).toBe('1400.00');
    expect(s2.grade).toBe(GradeCode.SEVERE);
    expect(s2.startDate).toBe('2024-02-15');
    expect(s2.endDate).toBe('2024-02-29');
    expect(s2.days).toBe(15);
    expect(s2.dailyRate).toBe('300.00');
    expect(s2.amount).toBe('4500.00');
    expect(res.body.totalAmount).toBe('5900.00');
  });

  it('费用：跨日费版本切换日（2024-01-01 调价）同等级期间内二次切分', async () => {
    // 另一位老人：2023-12-25 起 MODERATE，覆盖调价日
    const moderateAssess = await http
      .post('/api/assessments')
      .send(
        payload(
          'E-RATE',
          (() => {
            const o: Record<string, string> = {};
            for (const c of ITEMS_8) o[c] = OPT.MUCH_HELP; // 16/30=53.3%
            return answers(o);
          })(),
          (() => {
            const o: Record<string, string> = {};
            for (const c of ITEMS_8) o[c] = OPT.MUCH_HELP;
            return answers(o);
          })(),
        ),
      )
      .expect(201);
    expect(moderateAssess.body.confirmedGrade).toBe(GradeCode.MODERATE);

    await http
      .post('/api/fees/activate')
      .send({ caseId: moderateAssess.body.id, effectiveDate: '2023-12-25' })
      .expect(201);

    const res = await http
      .get('/api/fees/segments')
      .query({ elderId: 'E-RATE', from: '2023-12-25', to: '2024-01-10' })
      .expect(200);

    // 12/25~12/31 共 7 天 @180；1/1~1/10 共 10 天 @200
    expect(res.body.totalDays).toBe(17);
    expect(res.body.segments).toHaveLength(2);
    expect(res.body.segments[0].rateEffectiveFrom).toBe('2000-01-01');
    expect(res.body.segments[0].days).toBe(7);
    expect(res.body.segments[0].amount).toBe('1260.00');
    expect(res.body.segments[1].rateEffectiveFrom).toBe('2024-01-01');
    expect(res.body.segments[1].days).toBe(10);
    expect(res.body.segments[1].amount).toBe('2000.00');
    expect(res.body.totalAmount).toBe('3260.00');
  });

  it('费用：无生效等级的日期空洞单列 NO_EFFECTIVE_GRADE 且金额为 0', async () => {
    // 全新老人，只在 2024-03-10 起生效 LIGHT
    const c = await http
      .post('/api/assessments')
      .send(payload('E-GAP', answers({}), answers({})))
      .expect(201);
    await http
      .post('/api/fees/activate')
      .send({ caseId: c.body.id, effectiveDate: '2024-03-10' })
      .expect(201);

    const res = await http
      .get('/api/fees/segments')
      .query({ elderId: 'E-GAP', from: '2024-03-01', to: '2024-03-15' })
      .expect(200);

    expect(res.body.totalDays).toBe(15);
    const gap = res.body.segments.find((s: any) => s.source === 'NO_EFFECTIVE_GRADE');
    expect(gap).toMatchObject({
      startDate: '2024-03-01',
      endDate: '2024-03-09',
      days: 9,
      grade: null,
      amount: '0.00',
    });
    const paid = res.body.segments.find((s: any) => s.source === 'GRADE_PERIOD_AND_RATE');
    expect(paid.days).toBe(6);
    expect(paid.amount).toBe('600.00');
    expect(res.body.totalAmount).toBe('600.00');
  });

  it('费用：非法闰日期（2023-02-29）拒绝', async () => {
    const res = await http
      .get('/api/fees/segments')
      .query({ elderId: 'E-FEE', from: '2023-02-01', to: '2023-02-29' })
      .expect(409);
    expect(JSON.stringify(res.body)).toMatch(/不合法|INVALID/);
  });
});
