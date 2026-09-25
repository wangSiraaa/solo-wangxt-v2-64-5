import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { setupOpenApi } from '../src/openapi';
import {
  DeliveryChannel,
  GradeCode,
  NotificationKind,
  NotificationStatus,
  ReceiptEvent,
  SignoffState,
} from '../src/common/enums';

/**
 * 可靠回执与签收闭环 e2e（离线模拟多渠道投递器，不连接真实短信/外部服务）。
 *
 * 验收：
 *  1) 首次送达后签收形成完整证据链；
 *  2) 失败重试成功后旧失败迟到不回滚；旧尝试迟到送达不覆盖新尝试失败；
 *  3) 重复送达、重复签收不新增结果；
 *  4) 告知内容被新版本替代后旧版迟到签收只能留痕；
 *  5) 事务/重启后投递尝试、有效回执、签收与等级费用状态一致；
 *  6) 原有未确认/送达失败查询与“费用独立于送达”规则仍兼容。
 */
describe('家属告知：可靠回执归并与签收闭环 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;

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
  };

  function allIndependent() {
    const map: Record<string, string> = {};
    for (const code of ITEMS_8) map[code] = OPT.INDEPENDENT;
    map.STAIRS = OPT.INDEPENDENT;
    map.OUTDOOR = OPT.INDEPENDENT;
    return Object.entries(map).map(([itemCode, optionCode]) => ({
      itemCode,
      optionCode,
    }));
  }

  async function createConfirmedCase(
    elderId: string,
    familyContact = '13900000000',
  ): Promise<string> {
    const res = await http
      .post('/api/assessments')
      .send({
        elderId,
        elderName: `老人${elderId}`,
        familyContact,
        assessors: [
          { assessorId: 1, answers: allIndependent() },
          { assessorId: 2, answers: allIndependent() },
        ],
      })
      .expect(201);
    expect(res.body.status).toBe('CONFIRMED');
    expect(res.body.confirmedGrade).toBe(GradeCode.LIGHT);
    return res.body.id;
  }

  /** 异步投递：仅受理；返回稳定投递号与首次尝试行 */
  async function dispatchAsync(caseId: string, channel?: DeliveryChannel) {
    const res = await http
      .post(`/api/assessments/${caseId}/notification/attempt`)
      .send({ asyncMode: true, channel })
      .expect(201);
    expect(res.body.kind).toBe(NotificationKind.ATTEMPT);
    expect(res.body.attemptNo).toBe(1);
    expect(res.body.status).toBe(NotificationStatus.ACCEPTED);
    expect(res.body.stableDeliveryNo).toMatch(/^DLV-[A-F0-9]{12}$/);
    return { deliveryNo: res.body.stableDeliveryNo as string, row: res.body };
  }

  function sendReceipt(caseId: string, body: any) {
    return http
      .post(`/api/assessments/${caseId}/notification/receipts`)
      .send(body);
  }

  async function getDelivery(caseId: string, deliveryNo: string) {
    const res = await http
      .get(
        `/api/assessments/${caseId}/notification/deliveries/${deliveryNo}`,
      )
      .expect(200);
    return res.body;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api');
    setupOpenApi(app);
    await app.init();
    http = request(app.getHttpServer());
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

  // -------------------------------------------------------------------------
  it('首次投递受理→送达→签收：稳定投递号、尝试序号、不可变快照与完整证据链', async () => {
    const caseId = await createConfirmedCase('E-CHAIN');
    const { deliveryNo } = await dispatchAsync(caseId, DeliveryChannel.WECHAT);

    // 受理（已发送）不是送达：此时签收被拒
    let d = await getDelivery(caseId, deliveryNo);
    expect(d.delivery.aggregateStatus).toBe(NotificationStatus.ACCEPTED);
    expect(d.delivery.attemptCount).toBe(1);
    await http
      .post(`/api/assessments/${caseId}/notification/signoffs`)
      .send({ stableDeliveryNo: deliveryNo, signoffKey: 'k-early' })
      .expect(409);

    // 渠道异步回传送达
    const r = await sendReceipt(caseId, {
      stableDeliveryNo: deliveryNo,
      attemptNo: 1,
      receiptEventId: 'evt-d-1',
      event: ReceiptEvent.DELIVERED,
      channel: DeliveryChannel.WECHAT,
    }).expect(201);
    expect(r.body.aggregateStatus).toBe(NotificationStatus.DELIVERED);
    expect(r.body.winningAttemptNo).toBe(1);

    // 快照不可变：尝试行与投递聚合的内容哈希一致
    d = await getDelivery(caseId, deliveryNo);
    const attempt1 = d.attempts.find((a: any) => a.attemptNo === 1);
    expect(attempt1.status).toBe(NotificationStatus.DELIVERED);
    expect(attempt1.contentHash).toBe(d.delivery.contentHash);
    expect(attempt1.contentSnapshot.contentHash).toBe(
      attempt1.contentHash,
    );
    expect(attempt1.contentSnapshot.message).toContain('不构成医疗诊断');

    // 家属签收绑定已送达版本
    const s = await http
      .post(`/api/assessments/${caseId}/notification/signoffs`)
      .send({
        stableDeliveryNo: deliveryNo,
        signoffKey: 'sign-1',
        signer: '张某家属',
        channel: DeliveryChannel.WECHAT,
      })
      .expect(201);
    expect(s.body.signoff.state).toBe(SignoffState.BOUND);
    expect(s.body.signoff.attemptNo).toBe(1);
    expect(s.body.signoff.contentHash).toBe(d.delivery.contentHash);
    // 签收引用了送达回执：证据链闭环
    expect(s.body.signoff.deliveredReceiptId).toBeTruthy();
    const deliveredReceipt = d.receipts.find(
      (x: any) => x.event === ReceiptEvent.DELIVERED,
    );
    expect(s.body.signoff.deliveredReceiptId).toBe(deliveredReceipt.id);

    // 时间线：版本创建 → 尝试 → 受理/送达回执 → 签收，顺序完整
    const tl = await http
      .get(`/api/assessments/${caseId}/notification/timeline`)
      .expect(200);
    const types = tl.body.events.map((e: any) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'NOTICE_VERSION_CREATED',
        'DELIVERY_ATTEMPTED',
        'RECEIPT',
        'SIGNED_OFF',
      ]),
    );
    const idxAttempt = types.indexOf('DELIVERY_ATTEMPTED');
    const idxSign = types.indexOf('SIGNED_OFF');
    expect(idxAttempt).toBeLessThan(idxSign);
    expect(tl.body.currentVersion.status).toBe(NotificationStatus.DELIVERED);
  });

  // -------------------------------------------------------------------------
  it('重复送达回执不新增结果；重复签收不新增结果（幂等）', async () => {
    const caseId = await createConfirmedCase('E-DUP');
    const { deliveryNo } = await dispatchAsync(caseId);

    await sendReceipt(caseId, {
      stableDeliveryNo: deliveryNo,
      attemptNo: 1,
      receiptEventId: 'evt-dup-d',
      event: ReceiptEvent.DELIVERED,
    }).expect(201);

    // 相同事件号重复回传：duplicate=true，尝试数/回执语义不变
    const dup = await sendReceipt(caseId, {
      stableDeliveryNo: deliveryNo,
      attemptNo: 1,
      receiptEventId: 'evt-dup-d',
      event: ReceiptEvent.DELIVERED,
    }).expect(201);
    expect(dup.body.duplicate).toBe(true);

    const s1 = await http
      .post(`/api/assessments/${caseId}/notification/signoffs`)
      .send({ stableDeliveryNo: deliveryNo, signoffKey: 'sk-dup' })
      .expect(201);
    const s2 = await http
      .post(`/api/assessments/${caseId}/notification/signoffs`)
      .send({ stableDeliveryNo: deliveryNo, signoffKey: 'sk-dup' })
      .expect(201);
    expect(s2.body.signoff.id).toBe(s1.body.signoff.id);

    // 换一个签收键对同一已签收投递：同样回放，不产生第二条 BOUND
    const s3 = await http
      .post(`/api/assessments/${caseId}/notification/signoffs`)
      .send({ stableDeliveryNo: deliveryNo, signoffKey: 'sk-other' })
      .expect(201);
    expect(s3.body.signoff.id).toBe(s1.body.signoff.id);

    const d = await getDelivery(caseId, deliveryNo);
    expect(d.attempts).toHaveLength(1); // 没有新增尝试
    expect(d.signoffs.filter((x: any) => x.state === SignoffState.BOUND)).toHaveLength(1);
    // 原始送达回执只保留一条（重复回执未新增）
    expect(
      d.receipts.filter((x: any) => x.receiptEventId === 'evt-dup-d'),
    ).toHaveLength(1);

    // 已送达投递再请求重试 → 409，不新增尝试
    await http
      .post(
        `/api/assessments/${caseId}/notification/deliveries/${deliveryNo}/retry`,
      )
      .send({})
      .expect(409);
    const d2 = await getDelivery(caseId, deliveryNo);
    expect(d2.attempts).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  it('并发重复签收：数据库部分唯一索引兜底，每个投递至多一条 BOUND', async () => {
    const caseId = await createConfirmedCase('E-CONC');
    const { deliveryNo } = await dispatchAsync(caseId);
    await sendReceipt(caseId, {
      stableDeliveryNo: deliveryNo,
      attemptNo: 1,
      receiptEventId: 'evt-conc-d',
      event: ReceiptEvent.DELIVERED,
    }).expect(201);

    // 不同签收键并发签收同一投递：至多一条 BOUND，其余回放同一条
    const keys = ['c1', 'c2', 'c3', 'c4'];
    const results = await Promise.all(
      keys.map((k) =>
        http
          .post(`/api/assessments/${caseId}/notification/signoffs`)
          .send({ stableDeliveryNo: deliveryNo, signoffKey: k }),
      ),
    );
    for (const r of results) {
      expect([200, 201]).toContain(r.status);
      expect(r.body.signoff.state).toBe(SignoffState.BOUND);
    }
    const ids = new Set(results.map((r: any) => r.body.signoff.id));
    expect(ids.size).toBe(1); // 全部回放同一条有效签收

    const d = await getDelivery(caseId, deliveryNo);
    expect(d.signoffs.filter((x: any) => x.state === SignoffState.BOUND)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  it('失败重试成功后：旧失败/旧送达迟到都不回滚已送达的最终状态', async () => {
    const caseId = await createConfirmedCase('E-RETRY');

    // 第一次尝试：同步模拟失败（网关超时）→ attempt 1 FAILED
    const a1 = await http
      .post(`/api/assessments/${caseId}/notification/attempt`)
      .send({ simulateFail: true })
      .expect(201);
    expect(a1.body.status).toBe(NotificationStatus.FAILED);
    expect(a1.body.attemptNo).toBe(1);
    const deliveryNo = a1.body.stableDeliveryNo;

    let d = await getDelivery(caseId, deliveryNo);
    expect(d.delivery.aggregateStatus).toBe(NotificationStatus.FAILED);
    expect(d.delivery.winningAttemptNo).toBe(1);

    // 第二次尝试（同稳定投递号）：异步受理 → attempt 2
    const a2 = await http
      .post(
        `/api/assessments/${caseId}/notification/deliveries/${deliveryNo}/retry`,
      )
      .send({ asyncMode: true, channel: DeliveryChannel.SMS })
      .expect(201);
    expect(a2.body.stableDeliveryNo).toBe(deliveryNo);
    expect(a2.body.attemptNo).toBe(2);
    expect(a2.body.contentHash).toBe(a1.body.contentHash); // 重试内容快照不变

    // 尝试 2 送达
    await sendReceipt(caseId, {
      stableDeliveryNo: deliveryNo,
      attemptNo: 2,
      receiptEventId: 'evt-a2-delivered',
      event: ReceiptEvent.DELIVERED,
    }).expect(201);

    d = await getDelivery(caseId, deliveryNo);
    expect(d.delivery.aggregateStatus).toBe(NotificationStatus.DELIVERED);
    expect(d.delivery.winningAttemptNo).toBe(2);

    // 旧尝试 1 的失败“迟到”（新事件号，原始证据照留）→ 不回滚
    const lateFail = await sendReceipt(caseId, {
      stableDeliveryNo: deliveryNo,
      attemptNo: 1,
      receiptEventId: 'evt-a1-fail-late',
      event: ReceiptEvent.FAILED,
      failureReason: '迟到的网关失败回执',
    }).expect(201);
    expect(lateFail.body.aggregateStatus).toBe(NotificationStatus.DELIVERED);
    expect(lateFail.body.winningAttemptNo).toBe(2);
    expect(lateFail.body.note).toContain('不覆盖');

    // 旧尝试 1 的送达迟到同样不能改变最终状态（赢家仍是尝试 2）
    const lateDelivered = await sendReceipt(caseId, {
      stableDeliveryNo: deliveryNo,
      attemptNo: 1,
      receiptEventId: 'evt-a1-delivered-late',
      event: ReceiptEvent.DELIVERED,
    }).expect(201);
    expect(lateDelivered.body.aggregateStatus).toBe(NotificationStatus.DELIVERED);
    expect(lateDelivered.body.winningAttemptNo).toBe(2);
    expect(lateDelivered.body.note).toContain('不覆盖');

    d = await getDelivery(caseId, deliveryNo);
    expect(d.attempts).toHaveLength(2); // 迟到回执不新增尝试
    expect(d.attempts.find((x: any) => x.attemptNo === 1).status).toBe(
      NotificationStatus.FAILED,
    );
    expect(d.attempts.find((x: any) => x.attemptNo === 2).status).toBe(
      NotificationStatus.DELIVERED,
    );
    // 回执全部留痕（含迟到），但 changedAggregate=false
    const a1LateFail = d.receipts.find(
      (x: any) => x.receiptEventId === 'evt-a1-fail-late',
    );
    expect(a1LateFail.changedAggregate).toBe(false);

    // 此时签收闭环在尝试 2 上
    const s = await http
      .post(`/api/assessments/${caseId}/notification/signoffs`)
      .send({ stableDeliveryNo: deliveryNo, signoffKey: 'sk-retry' })
      .expect(201);
    expect(s.body.signoff.state).toBe(SignoffState.BOUND);
    expect(s.body.signoff.attemptNo).toBe(2);
  });

  // -------------------------------------------------------------------------
  it('乱序：新尝试先失败，旧尝试后送达——旧尝试迟到送达不覆盖新尝试失败', async () => {
    const caseId = await createConfirmedCase('E-ORDER');
    const { deliveryNo } = await dispatchAsync(caseId); // attempt1 ACCEPTED
    await http
      .post(
        `/api/assessments/${caseId}/notification/deliveries/${deliveryNo}/retry`,
      )
      .send({ asyncMode: true })
      .expect(201); // attempt2 ACCEPTED

    // 尝试 2 先失败
    await sendReceipt(caseId, {
      stableDeliveryNo: deliveryNo,
      attemptNo: 2,
      receiptEventId: 'evt-o-a2-fail',
      event: ReceiptEvent.FAILED,
      failureReason: '空号',
    }).expect(201);
    // 尝试 1 后送达（乱序迟到）
    const late = await sendReceipt(caseId, {
      stableDeliveryNo: deliveryNo,
      attemptNo: 1,
      receiptEventId: 'evt-o-a1-delivered',
      event: ReceiptEvent.DELIVERED,
    }).expect(201);

    // 最终状态仍以最高序号尝试 2 的失败为准（不能简单取“已送达”）
    expect(late.body.aggregateStatus).toBe(NotificationStatus.FAILED);
    expect(late.body.winningAttemptNo).toBe(2);
    const d = await getDelivery(caseId, deliveryNo);
    expect(d.delivery.aggregateStatus).toBe(NotificationStatus.FAILED);

    // 失败状态下签收被拒（不能把“旧尝试送达”当有效送达）
    await http
      .post(`/api/assessments/${caseId}/notification/signoffs`)
      .send({ stableDeliveryNo: deliveryNo, signoffKey: 'sk-order' })
      .expect(409);
  });

  // -------------------------------------------------------------------------
  it('早到 SIGNED 回执：先留痕排队（409），送达后自动绑定为 BOUND', async () => {
    const caseId = await createConfirmedCase('E-EARLY');
    const { deliveryNo } = await dispatchAsync(caseId);

    // SIGNED 早于 DELIVERED：回执持久化、签收排队，接口给 409
    const early = await sendReceipt(caseId, {
      stableDeliveryNo: deliveryNo,
      attemptNo: 1,
      receiptEventId: 'evt-early-sign',
      event: ReceiptEvent.SIGNED,
      signoffKey: 'sk-early-q',
      signer: '家属',
    });
    expect(early.status).toBe(409);
    let d = await getDelivery(caseId, deliveryNo);
    expect(
      d.receipts.find((x: any) => x.receiptEventId === 'evt-early-sign'),
    ).toBeTruthy(); // 回执未因事务失败而丢失
    expect(
      d.signoffs.filter((x: any) => x.state === SignoffState.BOUND),
    ).toHaveLength(0);

    // 送达后，排队签收自动闭环（不要求家属再次操作）
    await sendReceipt(caseId, {
      stableDeliveryNo: deliveryNo,
      attemptNo: 1,
      receiptEventId: 'evt-early-delivered',
      event: ReceiptEvent.DELIVERED,
    }).expect(201);
    d = await getDelivery(caseId, deliveryNo);
    const bound = d.signoffs.find((x: any) => x.signoffKey === 'sk-early-q');
    expect(bound.state).toBe(SignoffState.BOUND);
    expect(bound.deliveredReceiptId).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  it('内容版本替代：新版本送达签收正常；旧版本迟到签收只能 STALE_TRACE 留痕', async () => {
    const caseId = await createConfirmedCase('E-VERSION');

    // 旧版本 v1 投递并异步受理（未送达）
    const old = await dispatchAsync(caseId, DeliveryChannel.VOICE);

    // 机构重新告知 → v2，v1 被替代
    const rn = await http
      .post(`/api/assessments/${caseId}/notification/renotify`)
      .send({ supplement: '补充护理等级说明' })
      .expect(201);
    expect(rn.body.anchor.contentVersion).toBe(2);
    expect(rn.body.superseded.contentVersion).toBe(1);
    expect(rn.body.superseded.status).toBe(NotificationStatus.SUPERSEDED);
    expect(rn.body.superseded.supersededById).toBe(rn.body.anchor.id);

    // 新版本投递并送达
    const v2 = await http
      .post(`/api/assessments/${caseId}/notification/attempt`)
      .send({ asyncMode: true })
      .expect(201);
    expect(v2.body.contentVersion).toBe(2);
    const v2No = v2.body.stableDeliveryNo;
    await sendReceipt(caseId, {
      stableDeliveryNo: v2No,
      attemptNo: 1,
      receiptEventId: 'evt-v2-delivered',
      event: ReceiptEvent.DELIVERED,
    }).expect(201);
    const sV2 = await http
      .post(`/api/assessments/${caseId}/notification/signoffs`)
      .send({ stableDeliveryNo: v2No, signoffKey: 'sk-v2' })
      .expect(201);
    expect(sV2.body.signoff.state).toBe(SignoffState.BOUND);

    // 旧版本 v1 的投递“迟到送达”后再签收：只能留痕，不绑定有效签收
    await sendReceipt(caseId, {
      stableDeliveryNo: old.deliveryNo,
      attemptNo: 1,
      receiptEventId: 'evt-v1-late-delivered',
      event: ReceiptEvent.DELIVERED,
    }).expect(201);
    const sV1 = await http
      .post(`/api/assessments/${caseId}/notification/signoffs`)
      .send({ stableDeliveryNo: old.deliveryNo, signoffKey: 'sk-v1-late' })
      .expect(201);
    expect(sV1.body.signoff.state).toBe(SignoffState.STALE_TRACE);
    expect(sV1.body.signoff.deliveredReceiptId).toBeNull();
    expect(sV1.body.signoff.traceNote).toContain('替代');

    // 旧版本早到且排队的签收，版本被替代后再送达 → 永久留痕
    const old2 = await dispatchAsync(caseId);
    await sendReceipt(caseId, {
      stableDeliveryNo: old2.deliveryNo,
      attemptNo: 1,
      receiptEventId: 'evt-v1b-early-sign',
      event: ReceiptEvent.SIGNED,
      signoffKey: 'sk-v1b-q',
    }).expect(409);
    await http
      .post(`/api/assessments/${caseId}/notification/renotify`)
      .send({})
      .expect(201); // v3 → v2 替代
    await sendReceipt(caseId, {
      stableDeliveryNo: old2.deliveryNo,
      attemptNo: 1,
      receiptEventId: 'evt-v1b-late-delivered',
      event: ReceiptEvent.DELIVERED,
    }).expect(201);
    const d = await getDelivery(caseId, old2.deliveryNo);
    const traced = d.signoffs.find((x: any) => x.signoffKey === 'sk-v1b-q');
    expect(traced.state).toBe(SignoffState.STALE_TRACE);
    expect(traced.traceNote).toContain('新版本替代');
  });

  // -------------------------------------------------------------------------
  it('重启后：投递尝试、有效回执、签收状态保持一致（持久化恢复）', async () => {
    const caseId = await createConfirmedCase('E-RESTART');
    const { deliveryNo } = await dispatchAsync(caseId);
    await sendReceipt(caseId, {
      stableDeliveryNo: deliveryNo,
      attemptNo: 1,
      receiptEventId: 'evt-restart-d',
      event: ReceiptEvent.DELIVERED,
    }).expect(201);
    await http
      .post(`/api/assessments/${caseId}/notification/signoffs`)
      .send({ stableDeliveryNo: deliveryNo, signoffKey: 'sk-restart' })
      .expect(201);

    // 用同一数据库重新启动一个应用实例（模拟服务重启；建表/种子幂等）
    const moduleRef2 = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app2 = moduleRef2.createNestApplication();
    app2.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app2.setGlobalPrefix('api');
    await app2.init();
    try {
      const http2 = request(app2.getHttpServer());
      const res = await http2
        .get(
          `/api/assessments/${caseId}/notification/deliveries/${deliveryNo}`,
        )
        .expect(200);
      expect(res.body.delivery.aggregateStatus).toBe(
        NotificationStatus.DELIVERED,
      );
      expect(res.body.delivery.winningAttemptNo).toBe(1);
      const bound = res.body.signoffs.find(
        (x: any) => x.signoffKey === 'sk-restart',
      );
      expect(bound.state).toBe(SignoffState.BOUND);
      // 重启后重复回执依然幂等
      const dup = await http2
        .post(`/api/assessments/${caseId}/notification/receipts`)
        .send({
          stableDeliveryNo: deliveryNo,
          attemptNo: 1,
          receiptEventId: 'evt-restart-d',
          event: ReceiptEvent.DELIVERED,
        })
        .expect(201);
      expect(dup.body.duplicate).toBe(true);
    } finally {
      await app2.close();
    }
  });

  // -------------------------------------------------------------------------
  it('送达/签收与等级费用完全独立：已确认即可生效，未送达也能计费', async () => {
    const caseId = await createConfirmedCase('E-FEE-INDEP');
    const { deliveryNo } = await dispatchAsync(caseId);
    // 仅受理（未送达、未签收）→ 等级生效照常
    await http
      .post('/api/fees/activate')
      .send({ caseId, effectiveDate: '2024-03-01' })
      .expect(201);
    const seg = await http
      .get('/api/fees/segments')
      .query({ elderId: 'E-FEE-INDEP', from: '2024-03-01', to: '2024-03-05' })
      .expect(200);
    expect(seg.body.totalAmount).toBe('500.00'); // 5 天 × LIGHT 100

    // 送达与签收后费用结果不发生变化
    await sendReceipt(caseId, {
      stableDeliveryNo: deliveryNo,
      attemptNo: 1,
      receiptEventId: 'evt-fee-d',
      event: ReceiptEvent.DELIVERED,
    }).expect(201);
    await http
      .post(`/api/assessments/${caseId}/notification/signoffs`)
      .send({ stableDeliveryNo: deliveryNo, signoffKey: 'sk-fee' })
      .expect(201);
    const seg2 = await http
      .get('/api/fees/segments')
      .query({ elderId: 'E-FEE-INDEP', from: '2024-03-01', to: '2024-03-05' })
      .expect(200);
    expect(seg2.body.totalAmount).toBe('500.00');
  });

  // -------------------------------------------------------------------------
  it('兼容历史：未确认尝试为 UNCONFIRMED/FAILED 且无投递号；失败尝试行可列表查询', async () => {
    // 冲突案件（PENDING_REVIEW）尝试告知
    const heavy: Record<string, string> = {};
    for (const c of ITEMS_8) heavy[c] = OPT.TOTAL_DEP;
    heavy.STAIRS = OPT.TOTAL_DEP;
    const c = await http
      .post('/api/assessments')
      .send({
        elderId: 'E-UNCONF',
        elderName: '老人E-UNCONF',
        familyContact: '13900000001',
        assessors: [
          {
            assessorId: 1,
            answers: Object.entries(heavy).map(([itemCode, optionCode]) => ({
              itemCode,
              optionCode,
            })),
          },
          { assessorId: 2, answers: allIndependent() },
        ],
      })
      .expect(201);
    expect(c.body.status).toBe('PENDING_REVIEW');

    const a = await http
      .post(`/api/assessments/${c.body.id}/notification/attempt`)
      .send({})
      .expect(201);
    expect(a.body.notifiableStatus).toBe('UNCONFIRMED');
    expect(a.body.status).toBe('FAILED');
    expect(a.body.stableDeliveryNo).toBeNull();
    expect(a.body.failureReason).toContain('尚未确认');

    const list = await http
      .get(`/api/assessments/${c.body.id}/notification`)
      .expect(200);
    // 未确认案件没有锚点告知，只有 1 条未确认尝试行
    expect(list.body).toHaveLength(1);
    expect(list.body[0].status).toBe('FAILED');

    // 已确认案件列表：锚点行 + 每次尝试行（历史扁平视图）
    const confirmed = await createConfirmedCase('E-LIST');
    await http
      .post(`/api/assessments/${confirmed}/notification/attempt`)
      .send({ simulateFail: true })
      .expect(201);
    const rows = await http
      .get(`/api/assessments/${confirmed}/notification`)
      .expect(200);
    const anchors = rows.body.filter((x: any) => x.kind === NotificationKind.ANCHOR);
    const attempts = rows.body.filter((x: any) => x.kind === NotificationKind.ATTEMPT);
    expect(anchors).toHaveLength(1);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe('FAILED');
    expect(attempts[0].failureReason).toContain('网关超时');
  });

  // -------------------------------------------------------------------------
  it('显式签收绑定到最终送达的尝试（即使旧尝试失败），且跨尝试重复签收回放', async () => {
    const caseId = await createConfirmedCase('E-SIGNRETRY');
    // attempt1 失败
    const a1 = await http
      .post(`/api/assessments/${caseId}/notification/attempt`)
      .send({ simulateFail: true })
      .expect(201);
    const no = a1.body.stableDeliveryNo;
    // attempt2 异步受理后送达
    await http
      .post(`/api/assessments/${caseId}/notification/deliveries/${no}/retry`)
      .send({ asyncMode: true })
      .expect(201);
    await sendReceipt(caseId, {
      stableDeliveryNo: no,
      attemptNo: 2,
      receiptEventId: 'evt-sr-d2',
      event: ReceiptEvent.DELIVERED,
    }).expect(201);

    // 显式签收不要求客户端知道 attemptNo：自动绑定最终送达尝试 2
    const s = await http
      .post(`/api/assessments/${caseId}/notification/signoffs`)
      .send({ stableDeliveryNo: no, signoffKey: 'sr-key' })
      .expect(201);
    expect(s.body.signoff.state).toBe(SignoffState.BOUND);
    expect(s.body.signoff.attemptNo).toBe(2);
    expect(s.body.signoff.deliveredReceiptId).toBeTruthy();

    // 同一签收键再次签收（即使不传尝试信息）→ 回放同一条
    const s2 = await http
      .post(`/api/assessments/${caseId}/notification/signoffs`)
      .send({ stableDeliveryNo: no, signoffKey: 'sr-key' })
      .expect(201);
    expect(s2.body.signoff.id).toBe(s.body.signoff.id);
  });

  // -------------------------------------------------------------------------
  it('异常回执：未知投递号 404；尝试序号越界 400；非法事件 400', async () => {
    const caseId = await createConfirmedCase('E-BAD');
    const { deliveryNo } = await dispatchAsync(caseId);

    await sendReceipt(caseId, {
      stableDeliveryNo: 'DLV-NOPE000000',
      attemptNo: 1,
      receiptEventId: 'x',
      event: ReceiptEvent.DELIVERED,
    }).expect(404);

    await sendReceipt(caseId, {
      stableDeliveryNo: deliveryNo,
      attemptNo: 9,
      receiptEventId: 'x2',
      event: ReceiptEvent.DELIVERED,
    }).expect(400);

    await sendReceipt(caseId, {
      stableDeliveryNo: deliveryNo,
      attemptNo: 1,
      receiptEventId: 'x3',
      event: 'BOGUS',
    }).expect(400);
  });

  // -------------------------------------------------------------------------
  it('OpenAPI 文档包含投递/重试/回执/签收/时间线路径', async () => {
    const res = await http.get('/api/docs/openapi.json').expect(200);
    const paths = Object.keys(res.body.paths);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/api/assessments/{caseId}/notification/attempt',
        '/api/assessments/{caseId}/notification/deliveries/{stableDeliveryNo}/retry',
        '/api/assessments/{caseId}/notification/receipts',
        '/api/assessments/{caseId}/notification/signoffs',
        '/api/assessments/{caseId}/notification/renotify',
        '/api/assessments/{caseId}/notification/timeline',
      ]),
    );
  });
});
