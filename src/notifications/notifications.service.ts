import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { randomBytes, randomUUID } from 'crypto';
import { AssessmentCase } from '../entities/assessment-case.entity';
import {
  NoticeContentSnapshot,
  NotificationRecord,
} from '../entities/notification.entity';
import { NotificationDelivery } from '../entities/notification-delivery.entity';
import { NotificationReceipt } from '../entities/notification-receipt.entity';
import { NotificationSignoff } from '../entities/notification-signoff.entity';
import {
  CaseStatus,
  DeliveryChannel,
  NotifiableStatus,
  NotificationKind,
  NotificationStatus,
  ReceiptEvent,
  SignoffState,
} from '../common/enums';
import { NotifyAttemptDto } from './dto/notify-attempt.dto';
import { RetryDeliveryDto } from './dto/retry-delivery.dto';
import { ReceiptCallbackDto } from './dto/receipt-callback.dto';
import { SignoffDto } from './dto/signoff.dto';
import { RenotifyDto } from './dto/renotify.dto';
import { NotifyChannelService } from './notify-channel.service';
import { DeliveryStateService } from './delivery-state.service';
import { createAnchorNotice } from './notice-factory';
import {
  renotifyNoticeText,
  unconfirmedNoticeText,
} from './notice-content.util';

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(AssessmentCase)
    private readonly caseRepo: Repository<AssessmentCase>,
    @InjectRepository(NotificationRecord)
    private readonly notifRepo: Repository<NotificationRecord>,
    @InjectRepository(NotificationDelivery)
    private readonly deliveryRepo: Repository<NotificationDelivery>,
    @InjectRepository(NotificationReceipt)
    private readonly receiptRepo: Repository<NotificationReceipt>,
    @InjectRepository(NotificationSignoff)
    private readonly signoffRepo: Repository<NotificationSignoff>,
    private readonly channel: NotifyChannelService,
    private readonly state: DeliveryStateService,
    private readonly dataSource: DataSource,
  ) {}

  // -------------------------------------------------------------------------
  // 发起投递（兼容历史 POST /attempt）：确认案件 → 新稳定投递号 + 尝试序号 1；
  // 尚未确认案件 → 独立 UNCONFIRMED/FAILED 行，不产生投递号（历史行为保留）
  // -------------------------------------------------------------------------
  async attempt(
    caseId: string,
    dto: NotifyAttemptDto,
  ): Promise<NotificationRecord> {
    const assessmentCase = await this.caseRepo.findOne({
      where: { id: caseId },
      relations: { scaleVersion: true },
    });
    if (!assessmentCase) throw new NotFoundException('评估案件不存在');

    const isConfirmed = assessmentCase.status === CaseStatus.CONFIRMED;
    if (!isConfirmed) {
      return this.recordUnconfirmedAttempt(assessmentCase);
    }

    const anchor = await this.requireCurrentAnchor(caseId);
    const channel = dto.channel ?? DeliveryChannel.SMS;
    const snapshot = anchor.contentSnapshot!;

    // 渠道调用在事务外：失败/重启不会产生“无尝试记录的已发送”歧义；
    // 结果仍以同一回执归并状态机落库
    const dispatch = await this.channel.dispatch({
      familyContact: assessmentCase.familyContact,
      message: snapshot.message,
      forceFail: dto.simulateFail === true,
      channel,
      asyncMode: dto.asyncMode === true,
    });

    return this.dataSource.transaction(async (em) => {
      const locked = await em.findOne(NotificationRecord, {
        where: { id: anchor.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked || !locked.isCurrentVersion) {
        throw new ConflictException({
          code: 'NOTICE_VERSION_SUPERSEDED',
          message: '告知内容版本已被替代，请基于最新版本重新发起投递',
        });
      }

      const stableDeliveryNo = this.generateDeliveryNo();
      const delivery = new NotificationDelivery();
      delivery.assessmentCase = assessmentCase;
      delivery.stableDeliveryNo = stableDeliveryNo;
      delivery.anchorNotificationId = anchor.id;
      delivery.contentVersion = anchor.contentVersion;
      delivery.contentHash = anchor.contentHash!;
      delivery.lastChannel = channel;
      delivery.attemptCount = 1;
      delivery.aggregateStatus = NotificationStatus.PENDING;
      delivery.winningAttemptNo = null;
      delivery.lastFailureReason = null;
      delivery.aggregateAt = null;
      await em.save(delivery);

      const attemptRow = await this.createAttemptRow(em, {
        assessmentCase,
        anchor,
        snapshot,
        delivery,
        attemptNo: 1,
        channel,
      });

      await this.feedDispatchResult(em, {
        delivery,
        attemptNo: 1,
        accepted: dispatch.accepted,
        terminalEvent: dispatch.terminalEvent,
        failureReason: dispatch.failureReason,
        channel,
      });

      return em.findOneOrFail(NotificationRecord, {
        where: { id: attemptRow.id },
      });
    });
  }

  // -------------------------------------------------------------------------
  // 失败重试：同一稳定投递号下尝试序号 +1，内容快照不变；
  // 已送达投递拒绝新增尝试（重复送达不新增结果）。
  // -------------------------------------------------------------------------
  async retry(
    caseId: string,
    stableDeliveryNo: string,
    dto: RetryDeliveryDto,
  ): Promise<NotificationRecord> {
    const assessmentCase = await this.caseRepo.findOne({
      where: { id: caseId },
      relations: { scaleVersion: true },
    });
    if (!assessmentCase) throw new NotFoundException('评估案件不存在');

    const delivery = await this.findDeliveryForCase(caseId, stableDeliveryNo);
    if (delivery.aggregateStatus === NotificationStatus.DELIVERED) {
      throw new ConflictException({
        code: 'DELIVERY_ALREADY_DELIVERED',
        message: '投递已送达，重复送达不新增尝试',
        stableDeliveryNo,
      });
    }

    const anchor = await this.notifRepo.findOne({
      where: { id: delivery.anchorNotificationId },
    });
    if (!anchor) throw new NotFoundException('告知版本不存在');

    const channel = dto.channel ?? delivery.lastChannel ?? DeliveryChannel.SMS;

    const dispatch = await this.channel.dispatch({
      familyContact: assessmentCase.familyContact,
      message: anchor.message!,
      forceFail: dto.simulateFail === true,
      channel,
      asyncMode: dto.asyncMode === true,
    });

    return this.dataSource.transaction(async (em) => {
      const locked = await em.findOne(NotificationDelivery, {
        where: { id: delivery.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked) throw new NotFoundException('投递不存在');
      if (locked.aggregateStatus === NotificationStatus.DELIVERED) {
        throw new ConflictException({
          code: 'DELIVERY_ALREADY_DELIVERED',
          message: '投递已送达，重复送达不新增尝试',
        });
      }

      const attemptNo = locked.attemptCount + 1;
      locked.attemptCount = attemptNo;
      locked.lastChannel = channel;
      await em.save(locked);

      const attemptRow = await this.createAttemptRow(em, {
        assessmentCase,
        anchor,
        snapshot: anchor.contentSnapshot!,
        delivery: locked,
        attemptNo,
        channel,
      });

      await this.feedDispatchResult(em, {
        delivery: locked,
        attemptNo,
        accepted: dispatch.accepted,
        terminalEvent: dispatch.terminalEvent,
        failureReason: dispatch.failureReason,
        channel,
      });

      return em.findOneOrFail(NotificationRecord, {
        where: { id: attemptRow.id },
      });
    });
  }

  // -------------------------------------------------------------------------
  // 异步回执归并入口（离线投递器回传：受理/送达/失败/签收）
  // -------------------------------------------------------------------------
  async receiveReceipt(caseId: string, dto: ReceiptCallbackDto) {
    const delivery = await this.findDeliveryForCase(
      caseId,
      dto.stableDeliveryNo,
    );
    if (dto.attemptNo < 1 || dto.attemptNo > delivery.attemptCount) {
      // 提前给出可读 400，状态机内也有同样防线
      throw new BadRequestException({
        code: 'ATTEMPT_NO_OUT_OF_RANGE',
        message: `尝试序号 ${dto.attemptNo} 超出投递已发起的 ${delivery.attemptCount} 次`,
      });
    }

    const txResult = await this.dataSource.transaction(async (em) => {
      const result = await this.state.ingestReceipt(em, {
        stableDeliveryNo: dto.stableDeliveryNo,
        attemptNo: dto.attemptNo,
        receiptEventId: dto.receiptEventId,
        event: dto.event,
        channel: dto.channel ?? null,
        failureReason: dto.failureReason ?? null,
        occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : null,
        signoffKey: dto.signoffKey ?? null,
        signer: dto.signer ?? null,
        rawPayload: dto,
      });

      const refreshed = await em.findOneOrFail(NotificationDelivery, {
        where: { id: delivery.id },
      });

      return {
        result,
        aggregateStatus: refreshed.aggregateStatus,
        winningAttemptNo: refreshed.winningAttemptNo,
        signoff: result.signoff
          ? await em.findOne(NotificationSignoff, {
              where: { id: result.signoff.id },
            })
          : null,
      };
    });

    // SIGNED 早于送达：回执已落库并入待处理队列（事务已提交），对客户端给 409 语义
    if (txResult.result.signoffPending) {
      throw new ConflictException({
        code: 'SIGNOFF_NOT_DELIVERED',
        message:
          '签收只能绑定已送达的明确内容版本：该投递当前尚未送达，签收回执已留痕并排队等待送达',
        stableDeliveryNo: dto.stableDeliveryNo,
      });
    }

    return {
      duplicate: txResult.result.duplicate,
      ignoredUnknownAttempt: txResult.result.ignoredUnknownAttempt,
      note: txResult.result.note ?? null,
      aggregateStatus: txResult.aggregateStatus,
      winningAttemptNo: txResult.winningAttemptNo,
      signoff: txResult.signoff,
    };
  }

  // -------------------------------------------------------------------------
  // 家属显式签收
  // -------------------------------------------------------------------------
  async signoff(caseId: string, dto: SignoffDto) {
    const delivery = await this.findDeliveryForCase(
      caseId,
      dto.stableDeliveryNo,
    );

    try {
      return await this.dataSource.transaction(async (em) => {
        const locked = await em.findOne(NotificationDelivery, {
          where: { id: delivery.id },
          lock: { mode: 'pessimistic_write' },
        });
        const signoff = await this.state.resolveSignoff(em, {
          delivery: locked!,
          attemptNo: locked!.winningAttemptNo ?? delivery.attemptCount,
          signoffKey: dto.signoffKey,
          signer: dto.signer ?? null,
          channel: dto.channel ?? null,
          bindToSpecifiedAttempt: false,
        });
        const full = await em.findOneOrFail(NotificationDelivery, {
          where: { id: delivery.id },
        });
        return { signoff, delivery: full };
      });
    } catch (e: any) {
      if (e?.message?.startsWith?.('NOT_DELIVERED:')) {
        throw new ConflictException({
          code: 'SIGNOFF_NOT_DELIVERED',
          message:
            '签收只能绑定已送达的明确内容版本：投递未送达（已发送/已受理不等于送达）',
          stableDeliveryNo: dto.stableDeliveryNo,
        });
      }
      // 并发签收：部分唯一索引（每投递至多一条 BOUND）兜底 → 回放已有有效签收
      if (e?.code === '23505') {
        const existing = await this.signoffRepo.findOne({
          where: { deliveryId: delivery.id, state: SignoffState.BOUND },
        });
        const full = await this.deliveryRepo.findOneOrFail({
          where: { id: delivery.id },
        });
        if (existing) return { signoff: existing, delivery: full };
      }
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // 重新告知：确认内容形成新版本，旧版本被替代（旧版迟到签收只留痕）
  // -------------------------------------------------------------------------
  async renotify(caseId: string, dto: RenotifyDto) {
    const assessmentCase = await this.caseRepo.findOne({
      where: { id: caseId },
      relations: { scaleVersion: true },
    });
    if (!assessmentCase) throw new NotFoundException('评估案件不存在');
    if (assessmentCase.status !== CaseStatus.CONFIRMED) {
      throw new ConflictException({
        code: 'GRADE_NOT_CONFIRMED',
        message: '等级尚未确认，不能生成新的告知内容版本',
      });
    }

    return this.dataSource.transaction(async (em) => {
      const current = await em.findOne(NotificationRecord, {
        where: { assessmentCase: { id: caseId }, isCurrentVersion: true, kind: NotificationKind.ANCHOR },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current) {
        throw new ConflictException({
          code: 'NO_CONFIRMED_NOTICE',
          message: '案件缺少已确认告知版本，无法重新告知',
        });
      }

      const message = renotifyNoticeText(
        assessmentCase.elderName,
        assessmentCase.scaleVersion.title,
        assessmentCase.confirmedGrade!,
        dto.supplement ?? null,
      );
      const anchor = await createAnchorNotice({
        em,
        assessmentCase,
        message,
        source: 'MANUAL_RENOTIFY',
        supplement: dto.supplement ?? null,
      });

      // 旧版本替代：已送达/已签收版本保留 DELIVERED 证据；其余落 SUPERSEDED
      current.isCurrentVersion = false;
      current.supersededById = anchor.id;
      current.supersededAt = new Date();
      if (
        current.status !== NotificationStatus.DELIVERED
      ) {
        current.status = NotificationStatus.SUPERSEDED;
      }
      await em.save(current);

      // 旧版本投递上“早到等待送达的签收”永久转为旧版留痕（不再自动绑定）
      const oldDeliveries = await em.find(NotificationDelivery, {
        where: { anchorNotificationId: current.id },
      });
      for (const d of oldDeliveries) {
        // 旧版本的每次尝试行标记为非当前版本（快照本身不变，仅版本归属留痕）
        await em.query(
          `UPDATE notification_records SET is_current_version = FALSE
            WHERE stable_delivery_no = $1 AND kind = 'ATTEMPT'`,
          [d.stableDeliveryNo],
        );
        const waiting = await em.find(NotificationSignoff, {
          where: { deliveryId: d.id, state: SignoffState.STALE_TRACE },
        });
        for (const s of waiting) {
          if ((s.traceNote ?? '').startsWith('PENDING')) {
            s.traceNote =
              '签收早于送达，送达前告知内容已被新版本替代：旧版本签收仅留痕，不绑定';
            await em.save(s);
          }
        }
      }

      return { anchor, superseded: current };
    });
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  /** 投递详情：聚合状态 + 每次尝试 + 全部回执 + 签收（证据链） */
  async getDelivery(caseId: string, stableDeliveryNo: string) {
    const delivery = await this.findDeliveryForCase(caseId, stableDeliveryNo);
    const [attempts, receipts, signoffs] = await Promise.all([
      this.notifRepo.find({
        where: { stableDeliveryNo },
        order: { attemptNo: 'ASC' },
      }),
      this.receiptRepo.find({
        where: { stableDeliveryNo },
        order: { receivedAt: 'ASC' },
      }),
      this.signoffRepo.find({
        where: { stableDeliveryNo },
        order: { signedAt: 'ASC' },
      }),
    ]);
    return { delivery, attempts, receipts, signoffs };
  }

  /** 案件告知时间线：版本创建 / 每次投递尝试 / 每条回执 / 签收，统一时间排序 */
  async timeline(caseId: string) {
    const assessmentCase = await this.caseRepo.findOne({
      where: { id: caseId },
    });
    if (!assessmentCase) throw new NotFoundException('评估案件不存在');

    const [records, receipts, signoffs] = await Promise.all([
      this.notifRepo.find({
        where: { assessmentCase: { id: caseId } },
        order: { createdAt: 'ASC' },
      }),
      this.dataSource.getRepository(NotificationReceipt)
        .createQueryBuilder('r')
        .innerJoin('r.delivery', 'd')
        .where('d.assessment_case_id = :id', { id: caseId })
        .orderBy('r.received_at', 'ASC')
        .getMany(),
      this.dataSource.getRepository(NotificationSignoff)
        .createQueryBuilder('s')
        .innerJoin('s.delivery', 'd')
        .where('d.assessment_case_id = :id', { id: caseId })
        .orderBy('s.signed_at', 'ASC')
        .getMany(),
    ]);

    type TimelineEvent = {
      at: string;
      seq: number;
      type: string;
      data: unknown;
    };
    const events: TimelineEvent[] = [];

    for (const r of records) {
      events.push({
        at: r.createdAt.toISOString(),
        seq: r.kind === NotificationKind.ANCHOR ? 0 : 1,
        type: r.kind === NotificationKind.ANCHOR
          ? 'NOTICE_VERSION_CREATED'
          : 'DELIVERY_ATTEMPTED',
        data: r,
      });
    }
    for (const rc of receipts) {
      events.push({
        at: (rc.occurredAt ?? rc.receivedAt).toISOString(),
        seq: 2,
        type: 'RECEIPT',
        data: rc,
      });
    }
    for (const s of signoffs) {
      events.push({
        at: s.signedAt.toISOString(),
        seq: 3,
        type: s.state === SignoffState.BOUND ? 'SIGNED_OFF' : 'SIGNOFF_TRACE',
        data: s,
      });
    }

    events.sort((a, b) =>
      a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq,
    );

    return {
      caseId,
      currentVersion: records
        .filter((r) => r.kind === NotificationKind.ANCHOR && r.isCurrentVersion)
        .map((r) => ({
          anchorNotificationId: r.id,
          contentVersion: r.contentVersion,
          status: r.status,
        }))[0] ?? null,
      events: events.map(({ type, data }) => ({ type, ...(data as object) })),
    };
  }

  /** 兼容历史：扁平告知记录列表（锚点行 + 每次尝试行，按时间升序） */
  listForCase(caseId: string) {
    return this.notifRepo.find({
      where: { assessmentCase: { id: caseId } },
      order: { createdAt: 'ASC' },
    });
  }

  // =========================================================================
  // 内部辅助
  // =========================================================================

  /** 尚未确认案件的尝试：独立 UNCONFIRMED/FAILED 行（历史口径，无投递号） */
  private async recordUnconfirmedAttempt(
    assessmentCase: AssessmentCase,
  ): Promise<NotificationRecord> {
    const message = unconfirmedNoticeText(
      assessmentCase.elderName,
      assessmentCase.status,
    );
    const record = new NotificationRecord();
    record.assessmentCase = assessmentCase;
    record.kind = NotificationKind.ATTEMPT;
    record.stableDeliveryNo = null;
    record.attemptNo = 0;
    record.anchorNotificationId = null;
    record.channel = null;
    record.attempts = 1;
    record.lastAttemptAt = new Date();
    record.contentVersion = 0;
    record.contentHash = null;
    record.contentSnapshot = null;
    record.isCurrentVersion = true;
    record.notifiableStatus = NotifiableStatus.UNCONFIRMED;
    record.message = message;
    record.status = NotificationStatus.FAILED;
    record.failureReason = '等级尚未确认，无法完成有效告知（通道虽可达）';
    return this.notifRepo.save(record);
  }

  private async requireCurrentAnchor(
    caseId: string,
  ): Promise<NotificationRecord> {
    const anchor = await this.notifRepo.findOne({
      where: {
        assessmentCase: { id: caseId },
        kind: NotificationKind.ANCHOR,
        isCurrentVersion: true,
      },
      order: { contentVersion: 'DESC' },
    });
    if (!anchor) {
      throw new ConflictException({
        code: 'NO_CONFIRMED_NOTICE',
        message: '案件缺少已确认告知版本',
      });
    }
    return anchor;
  }

  /** 新建一条尝试行（内容快照从锚点复制，不可变） */
  private async createAttemptRow(
    em: import('typeorm').EntityManager,
    params: {
      assessmentCase: AssessmentCase;
      anchor: NotificationRecord;
      snapshot: NoticeContentSnapshot;
      delivery: NotificationDelivery;
      attemptNo: number;
      channel: DeliveryChannel;
    },
  ): Promise<NotificationRecord> {
    const {
      assessmentCase,
      anchor,
      snapshot,
      delivery,
      attemptNo,
      channel,
    } = params;
    const now = new Date();
    const row = new NotificationRecord();
    row.id = randomUUID();
    row.assessmentCase = assessmentCase;
    row.kind = NotificationKind.ATTEMPT;
    row.stableDeliveryNo = delivery.stableDeliveryNo;
    row.attemptNo = attemptNo;
    row.anchorNotificationId = anchor.id;
    row.channel = channel;
    row.contentVersion = delivery.contentVersion;
    row.contentHash = delivery.contentHash;
    // 深拷贝快照：尝试时刻的内容固化，后续版本变化不影响本行
    row.contentSnapshot = {
      ...snapshot,
      capturedAt: snapshot.capturedAt,
    };
    // 尝试行的版本归属跟随锚点：旧版本上的重试不标记为当前版本
    row.isCurrentVersion = anchor.isCurrentVersion;
    row.supersededById = anchor.supersededById;
    row.supersededAt = null;
    row.status = NotificationStatus.PENDING;
    row.notifiableStatus = NotifiableStatus.CONFIRMED;
    row.message = snapshot.message;
    row.failureReason = null;
    row.attempts = 1;
    row.lastAttemptAt = now;
    return em.save(row);
  }

  /**
   * 将离线模拟投递器的同步受理/终态结果以“回执”喂入状态机，
   * 保证同步模式与异步回传走完全相同的归并路径。
   */
  private async feedDispatchResult(
    em: import('typeorm').EntityManager,
    params: {
      delivery: NotificationDelivery;
      attemptNo: number;
      accepted: boolean;
      terminalEvent: ReceiptEvent.DELIVERED | ReceiptEvent.FAILED | null;
      failureReason: string | null;
      channel: DeliveryChannel;
    },
  ): Promise<void> {
    const {
      delivery,
      attemptNo,
      accepted,
      terminalEvent,
      failureReason,
      channel,
    } = params;
    const base = `sys-${delivery.stableDeliveryNo}-${attemptNo}`;

    if (accepted) {
      await this.state.ingestReceipt(em, {
        stableDeliveryNo: delivery.stableDeliveryNo,
        attemptNo,
        receiptEventId: `${base}-accepted`,
        event: ReceiptEvent.ACCEPTED,
        channel,
        rawPayload: { simulated: true, phase: 'ACCEPTED' },
      });
    }
    if (terminalEvent) {
      await this.state.ingestReceipt(em, {
        stableDeliveryNo: delivery.stableDeliveryNo,
        attemptNo,
        receiptEventId: `${base}-${terminalEvent.toLowerCase()}`,
        event: terminalEvent,
        channel,
        failureReason,
        rawPayload: { simulated: true, phase: terminalEvent },
      });
    }
  }

  private generateDeliveryNo(): string {
    return `DLV-${randomBytes(6).toString('hex').toUpperCase()}`;
  }

  /** 按稳定投递号 + 案件查找投递（防止跨案件误操作） */
  private async findDeliveryForCase(
    caseId: string,
    stableDeliveryNo: string,
  ): Promise<NotificationDelivery> {
    const delivery = await this.deliveryRepo.findOne({
      where: { stableDeliveryNo },
    });
    const belongs =
      delivery &&
      (await this.notifRepo.count({
        where: { stableDeliveryNo, assessmentCase: { id: caseId } },
      })) > 0;
    if (!delivery || !belongs) {
      throw new NotFoundException({
        code: 'DELIVERY_NOT_FOUND',
        message: `投递号 ${stableDeliveryNo} 不存在`,
      });
    }
    return delivery;
  }
}
