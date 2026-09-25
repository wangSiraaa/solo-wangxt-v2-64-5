import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { GradeCode } from '../src/common/enums';

/**
 * 可靠回执与签收闭环 e2e：
 * 首次送达后签收形成完整证据链 / 失败重试成功后旧失败迟到不回滚 /
 * 重复送达与重复签收不新增结果 / 内容被新版本替代后旧版迟到签收仅留痕 /
 * 事务失败与重启后状态一致 / 未确认与送达失败查询兼容 / 已发送不等于已确认
 */
describe('家属告知 可靠回执与签收闭环 (e2e)', () => {
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

  function answers(override: Record<string, string> = {}) {
    const map: Record<string, string> = {};
    for (const code of ITEMS_8) map[code] = 'INDEPENDENT';
    map.STAIRS = 'INDEPENDENT';
    map.OUTDOOR = 'INDEPENDENT';
    Object.assign(map, override);
    return Object.entries(map).map(([itemCode, optionCode]) => ({
      itemCode,
      optionCode,
    }));
  }

  function severeAnswers() {
    const map: Record<string, string> = {};
    for (const code of ITEMS_8) map[code] = 'TOTAL_DEP';
    map.STAIRS = 'TOTAL_DEP';
    map.OUTDOOR = 'INDEPENDENT';
    return Object.entries(map).map(([itemCode, optionCode]) => ({
      itemCode,
      optionCode,
    }));
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

  /** 一致确认（LIGHT）案件 + 自动生成的 PENDING 告知记录 */
  async function createConfirmedCase(elderId: string, contact = '13800000000') {
    const res = await http
      .post('/api/assessments')
      .send(payload(elderId, answers({}), answers({}), contact))
      .expect(201);
    expect(res.body.status).toBe('CONFIRMED');
    const notification = res.body.notifications[0];
    expect(notification.status).toBe('PENDING');
    return { caseId: res.body.id as string, notification };
  }

  /** 冲突案件（LIGHT vs SEVERE）→ PENDING_REVIEW */
  async function createConflictCase(elderId: string) {
    const res = await http
      .post('/api/assessments')
      .send(payload(elderId, answers({}), severeAnswers()))
      .expect(201);
    expect(res.body.status).toBe('PENDING_REVIEW');
    return res.body.id as string;
  }

  async function postReceipt(
    eventId: string,
    deliveryNo: string,
    type: string,
    extra: Record<string, unknown> = {},
  ) {
    return http
      .post('/api/notification/receipts')
      .send({ receipts: [{ eventId, deliveryNo, type, ...extra }] });
  }

  async function bootApp() {
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
  }

  beforeAll(async () => {
    await bootApp();
    const ds = app.get(DataSource);
    await ds.query(`
      TRUNCATE notification_receipts, notification_signatures,
               notification_deliveries, notification_content_versions,
               grade_periods, notification_records, review_decisions,
               assessor_answers, assessment_cases RESTART IDENTITY CASCADE
    `);
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  // ---------------------------------------------------------------------------
  it('首次送达后签收：形成完整证据链（快照/投递号/回执/签收/时间线）', async () => {
    const { caseId, notification } = await createConfirmedCase('E-LOOP');

    // 1) 发起投递：不可变快照 + 稳定投递号 + 尝试序号 1
    const created = await http
      .post(`/api/assessments/${caseId}/notification/deliveries`)
      .send({ channel: 'SMS' })
      .expect(201);
    const delivery = created.body.delivery;
    expect(created.body.replayed).toBe(false);
    expect(delivery.deliveryNo).toMatch(/^DN-\d{6}$/);
    expect(delivery.attemptNo).toBe(1);
    expect(delivery.status).toBe('PENDING');
    expect(delivery.notifiableStatus).toBe('CONFIRMED');
    expect(delivery.contentVersion).toBe(1);
    expect(delivery.contentSnapshot).toBe(notification.message);
    expect(delivery.contentHash).toMatch(/^[0-9a-f]{64}$/);

    // 2) 投递器异步回传：受理 → 送达
    const accepted = await postReceipt('EV-L1-ACC', delivery.deliveryNo, 'ACCEPTED');
    expect(accepted.body.results[0]).toMatchObject({
      applied: true,
      replayed: false,
      notificationStatus: 'PENDING', // 受理不等于送达
    });

    const delivered = await postReceipt('EV-L1-DLV', delivery.deliveryNo, 'DELIVERED');
    expect(delivered.body.results[0]).toMatchObject({
      applied: true,
      notificationStatus: 'DELIVERED',
    });

    // 3) 家属签收：绑定已送达的明确内容版本
    const signed = await http
      .post(`/api/notification/deliveries/${delivery.deliveryNo}/sign`)
      .send({ signer: '家属甲', eventId: 'EV-L1-SIGN' })
      .expect(201);
    expect(signed.body.replayed).toBe(false);
    expect(signed.body.notificationStatus).toBe('SIGNED');
    expect(signed.body.signature).toMatchObject({
      status: 'VALID',
      signer: '家属甲',
      contentVersion: 1,
      contentHash: delivery.contentHash,
      deliveryNo: delivery.deliveryNo,
    });

    // 4) 告知记录级状态投影为 SIGNED（旧查询接口兼容可见）
    const list = await http
      .get(`/api/assessments/${caseId}/notification`)
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].status).toBe('SIGNED');
    expect(list.body[0].attempts).toBe(1);

    // 5) 证据链端点：投递快照 + 全部回执 + 签收
    const evidence = await http
      .get(`/api/notification/deliveries/${delivery.deliveryNo}`)
      .expect(200);
    expect(evidence.body.delivery.status).toBe('DELIVERED');
    expect(evidence.body.receipts.map((r: any) => r.type)).toEqual([
      'ACCEPTED',
      'DELIVERED',
      'SIGNED',
    ]);
    expect(evidence.body.receipts.every((r: any) => r.applied)).toBe(true);
    expect(evidence.body.signature.status).toBe('VALID');
    expect(evidence.body.notification.status).toBe('SIGNED');

    // 6) 时间线：完整事件序列
    const timeline = await http
      .get(`/api/assessments/${caseId}/notification/timeline`)
      .expect(200);
    const types = timeline.body.items.map((i: any) => i.type);
    expect(types).toEqual([
      'NOTIFICATION_CREATED',
      'CONTENT_VERSION',
      'DELIVERY_CREATED',
      'RECEIPT_ACCEPTED',
      'RECEIPT_DELIVERED',
      'RECEIPT_SIGNED',
      'SIGNATURE',
    ]);
    expect(timeline.body.items.map((i: any) => i.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('投递幂等：相同幂等键回放，不生成新投递', async () => {
    const { caseId } = await createConfirmedCase('E-IDEM');
    const first = await http
      .post(`/api/assessments/${caseId}/notification/deliveries`)
      .send({ idempotencyKey: 'dlv-key-1' })
      .expect(201);
    const again = await http
      .post(`/api/assessments/${caseId}/notification/deliveries`)
      .send({ idempotencyKey: 'dlv-key-1' })
      .expect(201);
    expect(again.body.replayed).toBe(true);
    expect(again.body.delivery.deliveryNo).toBe(first.body.delivery.deliveryNo);

    const deliveries = await http
      .get(`/api/assessments/${caseId}/notification/deliveries`)
      .expect(200);
    expect(deliveries.body).toHaveLength(1);

    // 重试幂等：失败后同键重试回放，不生成第三次尝试
    const d1 = first.body.delivery;
    await postReceipt('EV-IDEM-FAIL', d1.deliveryNo, 'FAILED', {
      reason: '模拟通道异常',
    });
    const r1 = await http
      .post(`/api/notification/deliveries/${d1.deliveryNo}/retry`)
      .send({ idempotencyKey: 'retry-key-1' })
      .expect(201);
    const r2 = await http
      .post(`/api/notification/deliveries/${d1.deliveryNo}/retry`)
      .send({ idempotencyKey: 'retry-key-1' })
      .expect(201);
    expect(r2.body.replayed).toBe(true);
    expect(r2.body.delivery.deliveryNo).toBe(r1.body.delivery.deliveryNo);
    const after = await http
      .get(`/api/assessments/${caseId}/notification/deliveries`)
      .expect(200);
    expect(after.body).toHaveLength(2);
  });

  it('失败重试成功后，旧失败迟到不回滚状态；旧尝试送达也不得覆盖新尝试', async () => {
    const { caseId } = await createConfirmedCase('E-RETRY');

    // 第一次投递 → 通道失败
    const d1 = (
      await http
        .post(`/api/assessments/${caseId}/notification/deliveries`)
        .send({})
        .expect(201)
    ).body.delivery;
    const failed = await postReceipt('EV-R1-FAIL', d1.deliveryNo, 'FAILED', {
      reason: '模拟通道异常：网关超时',
    });
    expect(failed.body.results[0].notificationStatus).toBe('FAILED');

    let list = await http.get(`/api/assessments/${caseId}/notification`).expect(200);
    expect(list.body[0].status).toBe('FAILED');
    expect(list.body[0].failureReason).toContain('网关超时');

    // 失败按策略重试：新投递号、尝试序号 2、同一内容版本重新快照
    const retry = await http
      .post(`/api/notification/deliveries/${d1.deliveryNo}/retry`)
      .send({ reason: '通道恢复后重试' })
      .expect(201);
    const d2 = retry.body.delivery;
    expect(retry.body.retryOf).toBe(d1.deliveryNo);
    expect(d2.deliveryNo).not.toBe(d1.deliveryNo);
    expect(d2.attemptNo).toBe(2);
    expect(d2.status).toBe('PENDING');
    expect(d2.contentVersion).toBe(1);

    // 重试期间告知级状态回到 PENDING（新尝试待回执）
    list = await http.get(`/api/assessments/${caseId}/notification`).expect(200);
    expect(list.body[0].status).toBe('PENDING');
    expect(list.body[0].attempts).toBe(2);

    // 新尝试送达成功
    const delivered = await postReceipt('EV-R2-DLV', d2.deliveryNo, 'DELIVERED');
    expect(delivered.body.results[0].notificationStatus).toBe('DELIVERED');

    // 旧尝试的失败回执迟到（重试后到达）：仅留痕，不回滚
    const lateFail = await postReceipt('EV-R1-FAIL-LATE', d1.deliveryNo, 'FAILED', {
      reason: '迟到的旧失败回执',
      occurredAt: '2026-09-25T01:00:00Z',
    });
    expect(lateFail.body.results[0]).toMatchObject({
      applied: false,
      notificationStatus: 'DELIVERED',
    });
    expect(lateFail.body.results[0].note).toContain('终态');

    // 旧尝试的“送达”同样不得覆盖新尝试最终状态
    const lateDelivered = await postReceipt('EV-R1-DLV-LATE', d1.deliveryNo, 'DELIVERED');
    expect(lateDelivered.body.results[0].applied).toBe(false);
    expect(lateDelivered.body.results[0].notificationStatus).toBe('DELIVERED');

    // 终态核验：尝试 1 FAILED、尝试 2 DELIVERED、告知 DELIVERED
    const deliveries = await http
      .get(`/api/assessments/${caseId}/notification/deliveries`)
      .expect(200);
    const byNo = Object.fromEntries(
      deliveries.body.map((d: any) => [d.deliveryNo, d]),
    );
    expect(byNo[d1.deliveryNo].status).toBe('FAILED');
    expect(byNo[d2.deliveryNo].status).toBe('DELIVERED');

    list = await http.get(`/api/assessments/${caseId}/notification`).expect(200);
    expect(list.body[0].status).toBe('DELIVERED');
    expect(list.body[0].failureReason).toBeNull();

    // 迟到回执均已留痕（证据链含 2 条未生效回执）
    const evidence = await http
      .get(`/api/notification/deliveries/${d1.deliveryNo}`)
      .expect(200);
    expect(evidence.body.receipts).toHaveLength(3);
    expect(
      evidence.body.receipts.filter((r: any) => !r.applied),
    ).toHaveLength(2);
  });

  it('重复送达与重复签收不新增结果（eventId 幂等 + 终态粘滞 + 单签收约束）', async () => {
    const { caseId } = await createConfirmedCase('E-DUP');
    const d = (
      await http
        .post(`/api/assessments/${caseId}/notification/deliveries`)
        .send({})
        .expect(201)
    ).body.delivery;

    // 同一 DELIVERED 事件重复回传 → 幂等回放
    await postReceipt('EV-D1', d.deliveryNo, 'DELIVERED');
    const dup = await postReceipt('EV-D1', d.deliveryNo, 'DELIVERED');
    expect(dup.body.results[0]).toMatchObject({
      applied: false,
      replayed: true,
      notificationStatus: 'DELIVERED',
    });

    // 不同 eventId 的再次送达 → 终态粘滞，仅留痕
    const dup2 = await postReceipt('EV-D2', d.deliveryNo, 'DELIVERED');
    expect(dup2.body.results[0]).toMatchObject({ applied: false, replayed: false });

    // 签收 → 同 eventId 重放 → 不同 eventId 重复签收：均不新增
    const s1 = await http
      .post(`/api/notification/deliveries/${d.deliveryNo}/sign`)
      .send({ signer: '家属甲', eventId: 'EV-S1' })
      .expect(201);
    expect(s1.body.signature.status).toBe('VALID');

    const s2 = await http
      .post(`/api/notification/deliveries/${d.deliveryNo}/sign`)
      .send({ signer: '家属甲', eventId: 'EV-S1' })
      .expect(201);
    expect(s2.body.replayed).toBe(true);
    expect(s2.body.signature.id).toBe(s1.body.signature.id);

    const s3 = await http
      .post(`/api/notification/deliveries/${d.deliveryNo}/sign`)
      .send({ signer: '家属乙', eventId: 'EV-S2' })
      .expect(201);
    expect(s3.body.replayed).toBe(true);
    expect(s3.body.signature.id).toBe(s1.body.signature.id); // 仍为首条签收

    // 证据链：回执 4 条（DELIVERED×3 + SIGNED×1），签收仅 1 条
    const evidence = await http
      .get(`/api/notification/deliveries/${d.deliveryNo}`)
      .expect(200);
    expect(evidence.body.receipts).toHaveLength(4);
    expect(evidence.body.signature.signer).toBe('家属甲');

    const list = await http
      .get(`/api/assessments/${caseId}/notification`)
      .expect(200);
    expect(list.body[0].status).toBe('SIGNED');
  });

  it('乱序回执：送达先于受理到达，受理后至仅留痕', async () => {
    const { caseId } = await createConfirmedCase('E-ORDER');
    const d = (
      await http
        .post(`/api/assessments/${caseId}/notification/deliveries`)
        .send({})
        .expect(201)
    ).body.delivery;

    const dlv = await postReceipt('EV-O-DLV', d.deliveryNo, 'DELIVERED');
    expect(dlv.body.results[0].applied).toBe(true);

    const acc = await postReceipt('EV-O-ACC', d.deliveryNo, 'ACCEPTED');
    expect(acc.body.results[0]).toMatchObject({
      applied: false,
      notificationStatus: 'DELIVERED',
    });

    const evidence = await http
      .get(`/api/notification/deliveries/${d.deliveryNo}`)
      .expect(200);
    expect(evidence.body.delivery.status).toBe('DELIVERED');
    expect(evidence.body.delivery.acceptedAt).toBeNull();
  });

  it('内容被新版本替代后，旧版迟到签收只能留痕；新版本重新投递签收后闭环', async () => {
    // 冲突案件 → 未确认时旧接口尝试告知（留下 UNCONFIRMED 记录 v1）
    const caseId = await createConflictCase('E-VERSION');
    const legacy = await http
      .post(`/api/assessments/${caseId}/notification/attempt`)
      .send({})
      .expect(201);
    const recordId = legacy.body.id;
    expect(legacy.body.notifiableStatus).toBe('UNCONFIRMED');

    // v1 内容投递并送达（快照为“尚未确认”文本）
    const d1 = (
      await http
        .post(`/api/assessments/${caseId}/notification/deliveries`)
        .send({ notificationId: recordId })
        .expect(201)
    ).body.delivery;
    expect(d1.contentVersion).toBe(1);
    expect(d1.contentSnapshot).toContain('尚未确认');
    await postReceipt('EV-V1-DLV', d1.deliveryNo, 'DELIVERED');

    // 管理复核确认 LIGHT → 内容刷新 → v2（确认文本）
    await http
      .post(`/api/assessments/${caseId}/review/confirm`)
      .send({
        confirmedGrade: GradeCode.LIGHT,
        reviewerId: 'mgr-li',
        comment: '复核确认轻度',
      })
      .expect(201);
    const refreshed = await http
      .post(`/api/assessments/${caseId}/notification/${recordId}/refresh`)
      .send({ reason: '等级已确认，更新告知内容' })
      .expect(201);
    expect(refreshed.body.refreshed).toBe(true);
    expect(refreshed.body.contentVersion).toBe(2);
    expect(refreshed.body.notification.message).toContain('经管理复核确认为 LIGHT');
    expect(refreshed.body.notification.notifiableStatus).toBe('CONFIRMED');

    // 旧版 v1 的迟到签收 → 仅留痕 SUPERSEDED，不生效
    const lateSign = await http
      .post(`/api/notification/deliveries/${d1.deliveryNo}/sign`)
      .send({ signer: '家属甲', eventId: 'EV-V1-SIGN' })
      .expect(201);
    expect(lateSign.body.signature.status).toBe('SUPERSEDED');
    expect(lateSign.body.notificationStatus).toBe('DELIVERED'); // 不是 SIGNED

    // 同一内容版本已有投递 → 409；新版本允许首次投递
    await http
      .post(`/api/assessments/${caseId}/notification/deliveries`)
      .send({ notificationId: recordId })
      .expect(201); // v2 首次投递（v1 投递不阻塞）
    const dupCurrent = await http
      .post(`/api/assessments/${caseId}/notification/deliveries`)
      .send({ notificationId: recordId })
      .expect(409);
    expect(JSON.stringify(dupCurrent.body)).toContain('DELIVERY_EXISTS_USE_RETRY');

    // v2 投递送达并签收 → 闭环
    const deliveries = await http
      .get(`/api/assessments/${caseId}/notification/deliveries`)
      .expect(200);
    const d2 = deliveries.body.find((x: any) => x.attemptNo === 2);
    expect(d2.contentVersion).toBe(2);
    expect(d2.contentSnapshot).toContain('经管理复核确认为 LIGHT');
    await postReceipt('EV-V2-DLV', d2.deliveryNo, 'DELIVERED');
    const sign2 = await http
      .post(`/api/notification/deliveries/${d2.deliveryNo}/sign`)
      .send({ signer: '家属甲', eventId: 'EV-V2-SIGN' })
      .expect(201);
    expect(sign2.body.signature.status).toBe('VALID');
    expect(sign2.body.signature.contentVersion).toBe(2);
    expect(sign2.body.notificationStatus).toBe('SIGNED');

    // 旧版签收留痕仍在；告知记录最终 SIGNED（v2）
    const evidence1 = await http
      .get(`/api/notification/deliveries/${d1.deliveryNo}`)
      .expect(200);
    expect(evidence1.body.signature.status).toBe('SUPERSEDED');
    const list = await http
      .get(`/api/assessments/${caseId}/notification`)
      .expect(200);
    const record = list.body.find((n: any) => n.id === recordId);
    expect(record.status).toBe('SIGNED');
    expect(record.contentVersion).toBe(2);

    // 时间线包含版本演进与两次签收（留痕 + 生效）
    const timeline = await http
      .get(`/api/assessments/${caseId}/notification/timeline`)
      .expect(200);
    const types = timeline.body.items.map((i: any) => i.type);
    // 该记录：v1 建档 + v2 内容替代（复核确认自动生成的另一告知记录另有其 v1）
    const recordVersions = timeline.body.items.filter(
      (i: any) => i.type === 'CONTENT_VERSION' && i.notificationId === recordId,
    );
    expect(recordVersions.map((i: any) => i.contentVersion)).toEqual([1, 2]);
    expect(types.filter((t: string) => t === 'SIGNATURE')).toHaveLength(2);
    const superseded = timeline.body.items.find(
      (i: any) => i.type === 'SIGNATURE' && i.detail.status === 'SUPERSEDED',
    );
    expect(superseded.summary).toContain('留痕');
  });

  it('签收只能绑定已送达的投递：未送达签收 409；重试策略受限', async () => {
    const { caseId } = await createConfirmedCase('E-GUARD');
    const d = (
      await http
        .post(`/api/assessments/${caseId}/notification/deliveries`)
        .send({})
        .expect(201)
    ).body.delivery;

    // 未送达签收 → 409
    const signEarly = await http
      .post(`/api/notification/deliveries/${d.deliveryNo}/sign`)
      .send({ signer: '家属甲' })
      .expect(409);
    expect(JSON.stringify(signEarly.body)).toContain('尚未送达');

    // 未失败不得重试
    await http
      .post(`/api/notification/deliveries/${d.deliveryNo}/retry`)
      .send({})
      .expect(409);

    // 受理后仍不得重试/签收
    await postReceipt('EV-G-ACC', d.deliveryNo, 'ACCEPTED');
    await http
      .post(`/api/notification/deliveries/${d.deliveryNo}/retry`)
      .send({})
      .expect(409);
    await http
      .post(`/api/notification/deliveries/${d.deliveryNo}/sign`)
      .send({ signer: '家属甲' })
      .expect(409);

    // 送达后重试同样被拒
    await postReceipt('EV-G-DLV', d.deliveryNo, 'DELIVERED');
    await http
      .post(`/api/notification/deliveries/${d.deliveryNo}/retry`)
      .send({})
      .expect(409);
  });

  it('回执批次事务失败整批回滚：投递尝试与有效回执不产生部分写入', async () => {
    const { caseId } = await createConfirmedCase('E-TX');
    const d = (
      await http
        .post(`/api/assessments/${caseId}/notification/deliveries`)
        .send({})
        .expect(201)
    ).body.delivery;

    // 批次：[合法送达, 未知投递号] → 整体 404，全部回滚
    await http
      .post('/api/notification/receipts')
      .send({
        receipts: [
          { eventId: 'EV-TX-1', deliveryNo: d.deliveryNo, type: 'DELIVERED' },
          { eventId: 'EV-TX-2', deliveryNo: 'DN-999999', type: 'DELIVERED' },
        ],
      })
      .expect(404);

    // 无任何部分写入：投递仍 PENDING、无回执、告知仍 PENDING
    const evidence = await http
      .get(`/api/notification/deliveries/${d.deliveryNo}`)
      .expect(200);
    expect(evidence.body.delivery.status).toBe('PENDING');
    expect(evidence.body.receipts).toHaveLength(0);
    const list = await http
      .get(`/api/assessments/${caseId}/notification`)
      .expect(200);
    expect(list.body[0].status).toBe('PENDING');

    // 合法回执随后可正常归并
    const ok = await postReceipt('EV-TX-1', d.deliveryNo, 'DELIVERED');
    expect(ok.body.results[0].applied).toBe(true);
  });

  it('未确认案件：已发送不等于已确认，费用生效仍按机构规则独立判断', async () => {
    const caseId = await createConflictCase('E-UNCONF');

    // 旧接口未确认尝试 → UNCONFIRMED + FAILED 兼容保留
    const legacy = await http
      .post(`/api/assessments/${caseId}/notification/attempt`)
      .send({})
      .expect(201);
    expect(legacy.body.notifiableStatus).toBe('UNCONFIRMED');
    expect(legacy.body.status).toBe('FAILED');
    expect(legacy.body.failureReason).toContain('尚未确认');

    // 新闭环投递：快照如实记录 UNCONFIRMED；即便送达也不等于等级已确认
    const d = (
      await http
        .post(`/api/assessments/${caseId}/notification/deliveries`)
        .send({ notificationId: legacy.body.id })
        .expect(201)
    ).body.delivery;
    expect(d.notifiableStatus).toBe('UNCONFIRMED');
    await postReceipt('EV-U-DLV', d.deliveryNo, 'DELIVERED');

    const list = await http
      .get(`/api/assessments/${caseId}/notification`)
      .expect(200);
    expect(list.body[0].status).toBe('DELIVERED');
    expect(list.body[0].notifiableStatus).toBe('UNCONFIRMED');

    // 费用生效仍被拒绝：等级未确认，与告知是否送达无关
    const activate = await http
      .post('/api/fees/activate')
      .send({ caseId, effectiveDate: '2024-03-01' })
      .expect(409);
    expect(JSON.stringify(activate.body)).toContain('GRADE_NOT_CONFIRMED');
  });

  it('无告知记录的案件不得发起投递（409）', async () => {
    const caseId = await createConflictCase('E-NONE');
    const res = await http
      .post(`/api/assessments/${caseId}/notification/deliveries`)
      .send({})
      .expect(409);
    expect(JSON.stringify(res.body)).toContain('NO_NOTIFICATION_RECORD');
  });

  it('重启后投递尝试、有效回执、签收与等级费用状态保持一致', async () => {
    // 1) 构造完整闭环 + 费用生效
    const { caseId } = await createConfirmedCase('E-RESTART');
    const d = (
      await http
        .post(`/api/assessments/${caseId}/notification/deliveries`)
        .send({})
        .expect(201)
    ).body.delivery;
    await postReceipt('EV-RS-ACC', d.deliveryNo, 'ACCEPTED');
    await postReceipt('EV-RS-DLV', d.deliveryNo, 'DELIVERED');
    await http
      .post(`/api/notification/deliveries/${d.deliveryNo}/sign`)
      .send({ signer: '家属甲', eventId: 'EV-RS-SIGN' })
      .expect(201);
    await http
      .post('/api/fees/activate')
      .send({ caseId, effectiveDate: '2024-02-01' })
      .expect(201);

    const snapshot = async () => {
      const [deliveries, evidence, timeline, notification, fees] =
        await Promise.all([
          http.get(`/api/assessments/${caseId}/notification/deliveries`),
          http.get(`/api/notification/deliveries/${d.deliveryNo}`),
          http.get(`/api/assessments/${caseId}/notification/timeline`),
          http.get(`/api/assessments/${caseId}/notification`),
          http
            .get('/api/fees/segments')
            .query({ elderId: 'E-RESTART', from: '2024-02-01', to: '2024-02-29' }),
        ]);
      return {
        deliveries: deliveries.body,
        evidence: evidence.body,
        timeline: timeline.body,
        notification: notification.body,
        fees: fees.body,
      };
    };

    const before = await snapshot();
    expect(before.notification[0].status).toBe('SIGNED');
    expect(before.evidence.receipts.filter((r: any) => r.applied)).toHaveLength(3);
    expect(before.fees.totalAmount).toBe('2900.00'); // 29 天 × 100

    // 2) 模拟重启：关闭应用，对同一数据库重新引导（触发既有库增量迁移路径）
    await app.close();
    await bootApp();

    // 3) 全部状态保持一致
    const after = await snapshot();
    expect(after.deliveries).toEqual(before.deliveries);
    expect(after.evidence).toEqual(before.evidence);
    expect(after.timeline).toEqual(before.timeline);
    expect(after.notification).toEqual(before.notification);
    expect(after.fees).toEqual(before.fees);

    // 4) 重启后幂等仍然有效：重复签收事件回放，不新增结果
    const replay = await http
      .post(`/api/notification/deliveries/${d.deliveryNo}/sign`)
      .send({ signer: '家属甲', eventId: 'EV-RS-SIGN' })
      .expect(201);
    expect(replay.body.replayed).toBe(true);
    const evidence = await http
      .get(`/api/notification/deliveries/${d.deliveryNo}`)
      .expect(200);
    expect(evidence.body.receipts).toHaveLength(3);
  });

  it('OpenAPI 描述可用且覆盖全部新接口', async () => {
    const res = await http.get('/api/openapi.json').expect(200);
    expect(res.body.openapi).toMatch(/^3\.0\./);
    const paths = Object.keys(res.body.paths);
    for (const p of [
      '/assessments',
      '/assessments/{id}',
      '/assessments/{caseId}/review/confirm',
      '/assessments/{caseId}/notification/attempt',
      '/assessments/{caseId}/notification',
      '/assessments/{caseId}/notification/deliveries',
      '/assessments/{caseId}/notification/timeline',
      '/assessments/{caseId}/notification/{notificationId}/refresh',
      '/notification/deliveries/{deliveryNo}',
      '/notification/deliveries/{deliveryNo}/retry',
      '/notification/deliveries/{deliveryNo}/sign',
      '/notification/receipts',
      '/fees/activate',
      '/fees/segments',
      '/scales/{id}',
    ]) {
      expect(paths).toContain(p);
    }
    // 关键约束写入描述：签收绑定已送达版本、旧版签收仅留痕
    const signOp =
      res.body.paths['/notification/deliveries/{deliveryNo}/sign'].post;
    expect(signOp.summary).toContain('已送达');
    expect(JSON.stringify(res.body.components.schemas.Signature)).toContain(
      'SUPERSEDED',
    );
  });
});
