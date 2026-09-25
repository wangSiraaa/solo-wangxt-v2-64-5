import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  NotificationStatus,
  ReceiptEvent,
  SignoffState,
} from '../common/enums';
import { NotificationDelivery } from '../entities/notification-delivery.entity';
import { NotificationRecord } from '../entities/notification.entity';
import { NotificationReceipt } from '../entities/notification-receipt.entity';
import { NotificationSignoff } from '../entities/notification-signoff.entity';

export interface IngestReceiptInput {
  stableDeliveryNo: string;
  attemptNo: number;
  receiptEventId: string;
  event: ReceiptEvent;
  channel?: string | null;
  failureReason?: string | null;
  occurredAt?: Date | null;
  signoffKey?: string | null;
  signer?: string | null;
  rawPayload?: unknown;
}

export interface IngestReceiptResult {
  duplicate: boolean;
  ignoredUnknownAttempt: boolean;
  delivery: NotificationDelivery;
  signoff?: NotificationSignoff | null;
  /** SIGNED 早于送达：已入待处理队列（回执仍持久化），调用方可据此返回 409 语义 */
  signoffPending?: boolean;
  note?: string | null;
}

export interface ResolveSignoffInput {
  delivery: NotificationDelivery;
  attemptNo: number;
  signoffKey: string;
  signer?: string | null;
  channel?: string | null;
  sourceReceiptId?: string | null;
  signedAt?: Date;
  /**
   * 签收是否针对指定的 attemptNo：
   *  - SIGNED 回执：true（家属在某条送达上签收，该尝试必须已送达）；
   *  - 显式签收接口：false（按投递当前最终送达尝试绑定）。
   */
  bindToSpecifiedAttempt?: boolean;
}

/** 签收前提不满足：投递未送达（或所指尝试非送达态） */
export class SignoffNotDeliveredError extends Error {
  constructor(public stableDeliveryNo: string) {
    super(`NOT_DELIVERED:${stableDeliveryNo}`);
    this.name = 'SignoffNotDeliveredError';
  }
}

/**
 * 回执归并状态机（事务内执行）。
 *
 * 不可变：回执只追加；attempt 行的内容快照与尝试序号创建后不再改变。
 * 归并：以“全部尝试中最高 attemptNo 的终态（DELIVERED/FAILED）”为最终状态，
 *   每次回执后从尝试行重算——因此无论回执如何乱序/迟到：
 *   - 旧尝试迟到的送达不会覆盖更新尝试的失败（反之亦然）；
 *   - 已形成的 DELIVERED 不会被后来失败回滚，已形成的 FAILED 也不会被
 *     旧尝试迟到送达“复活”；
 *   - ACCEPTED（已发送/渠道受理）只是中间态，永远不构成送达确认。
 * 签收：只能绑定已送达且内容版本仍为当前版本的投递，每个投递至多一条 BOUND；
 *   乱序早到的 SIGNED 进入待处理队列，待对应尝试送达后自动闭环或在版本替代时留痕。
 */
@Injectable()
export class DeliveryStateService {
  /**
   * 归并一条投递器回执。
   * 调用方保证 delivery 存在（不存在抛 DELIVERY_NOT_FOUND）；重复事件号 → duplicate。
   */
  async ingestReceipt(
    em: EntityManager,
    input: IngestReceiptInput,
  ): Promise<IngestReceiptResult> {
    const {
      stableDeliveryNo,
      attemptNo,
      receiptEventId,
      event,
      channel = null,
      failureReason = null,
      occurredAt = null,
      signoffKey = null,
      signer = null,
      rawPayload = null,
    } = input;

    // 锁定投递聚合行，串行化同号回执归并
    const delivery = await em.findOne(NotificationDelivery, {
      where: { stableDeliveryNo },
      lock: { mode: 'pessimistic_write' },
    });
    if (!delivery) throw new Error(`DELIVERY_NOT_FOUND:${stableDeliveryNo}`);

    // 重复回执：同事件号不新增结果（仍返回当前聚合）
    const existingReceipt = await em.findOne(NotificationReceipt, {
      where: { receiptEventId },
    });
    if (existingReceipt) {
      return {
        duplicate: true,
        ignoredUnknownAttempt: false,
        delivery,
        note: '重复回执已幂等忽略，未新增结果',
      };
    }

    const receipt = new NotificationReceipt();
    receipt.stableDeliveryNo = stableDeliveryNo;
    receipt.attemptNo = attemptNo;
    receipt.receiptEventId = receiptEventId;
    receipt.event = event;
    receipt.channel = channel;
    receipt.failureReason = failureReason;
    receipt.occurredAt = occurredAt;
    receipt.delivery = delivery;
    receipt.deliveryId = delivery.id;
    receipt.rawPayload = rawPayload ?? null;
    receipt.changedAggregate = false;
    receipt.mergeNote = null;

    // 尝试行（迟到回执可能指向历史尝试，也可能指向未知尝试）
    const attempt = await em.findOne(NotificationRecord, {
      where: { stableDeliveryNo, attemptNo },
    });

    if (!attempt) {
      // 未知尝试序号（如重启后序号不匹配）：只留痕，绝不归并
      receipt.mergeNote =
        `尝试序号 ${attemptNo} 不存在于投递 ${stableDeliveryNo}` +
        `（已创建 ${delivery.attemptCount} 次）：回执留痕不归并`;
      await em.save(receipt);
      return {
        duplicate: false,
        ignoredUnknownAttempt: true,
        delivery,
        note: receipt.mergeNote,
      };
    }

    if (event === ReceiptEvent.SIGNED) {
      // SIGNED 不影响送达聚合；尝试未送达时入待处理队列（回执照常持久化），
      // 待对应尝试送达且版本仍有效时自动闭环
      receipt.mergeNote = '签收事件：转签收闭环归并';
      await em.save(receipt);
      try {
        const signoff = await this.resolveSignoff(em, {
          delivery,
          attemptNo,
          signoffKey: signoffKey ?? receiptEventId,
          signer,
          channel,
          sourceReceiptId: receipt.id,
          signedAt: occurredAt ?? undefined,
        });
        return {
          duplicate: false,
          ignoredUnknownAttempt: false,
          delivery,
          signoff,
          note: signoff.traceNote ?? null,
        };
      } catch (e) {
        if (e instanceof SignoffNotDeliveredError) {
          await this.queuePendingSignoff(em, {
            delivery,
            attemptNo,
            signoffKey: signoffKey ?? receiptEventId,
            signer,
            channel,
            sourceReceiptId: receipt.id,
            signedAt: occurredAt ?? new Date(),
          });
          receipt.mergeNote =
            '签收事件早于送达：已入待处理队列，送达且版本仍有效时自动绑定';
          await em.save(receipt);
          return {
            duplicate: false,
            ignoredUnknownAttempt: false,
            delivery,
            signoff: null,
            signoffPending: true,
            note: receipt.mergeNote,
          };
        }
        throw e;
      }
    }

    // 尝试行状态推进：同尝试以首个观察到的终态为准，之后迟到事件只留痕
    let attemptNote: string | null = null;
    const attemptIsTerminal =
      attempt.status === NotificationStatus.DELIVERED ||
      attempt.status === NotificationStatus.FAILED;
    if (attemptIsTerminal) {
      attemptNote = `尝试 ${attemptNo} 已为 ${attempt.status}，迟到 ${event} 不覆盖尝试终态`;
    } else if (event === ReceiptEvent.ACCEPTED) {
      if (attempt.status === NotificationStatus.PENDING) {
        attempt.status = NotificationStatus.ACCEPTED;
        await em.save(attempt);
      }
      attemptNote = '渠道已受理（已发送），不构成送达确认';
    } else if (event === ReceiptEvent.DELIVERED) {
      attempt.status = NotificationStatus.DELIVERED;
      attempt.failureReason = null;
      await em.save(attempt);
    } else if (event === ReceiptEvent.FAILED) {
      attempt.status = NotificationStatus.FAILED;
      attempt.failureReason = failureReason;
      await em.save(attempt);
    }

    // 聚合重算：取全部尝试中最高 attemptNo 的终态；无终态取最高受理态
    const beforeStatus = delivery.aggregateStatus;
    const beforeWinner = delivery.winningAttemptNo;
    await this.recomputeAggregate(em, delivery, channel, failureReason);
    const changed =
      beforeStatus !== delivery.aggregateStatus ||
      beforeWinner !== delivery.winningAttemptNo;
    receipt.changedAggregate = changed;

    if (
      attemptIsTerminal &&
      isTerminalEvent(event)
    ) {
      receipt.mergeNote = attemptNote;
    } else if (
      isTerminalEvent(event) &&
      delivery.winningAttemptNo != null &&
      attemptNo < delivery.winningAttemptNo
    ) {
      receipt.mergeNote =
        `旧尝试 ${attemptNo} 的 ${event} 迟到：投递最终状态以更新尝试 ` +
        `${delivery.winningAttemptNo} 为准，不覆盖新尝试最终状态`;
    } else {
      receipt.mergeNote = attemptNote;
    }
    await em.save(receipt);

    let signoff: NotificationSignoff | null = null;
    if (delivery.aggregateStatus === NotificationStatus.DELIVERED) {
      // 仅当本次送达恰好是某条早到签收所指的尝试时，才自动闭环该签收
      signoff = await this.flushPendingSignoffs(em, delivery, attemptNo);
    }

    return {
      duplicate: false,
      ignoredUnknownAttempt: false,
      delivery,
      signoff,
      note: receipt.mergeNote,
    };
  }

  /**
   * 签收归并（显式签收接口与 SIGNED 回执共用）。
   * 同 signoffKey 重复 → 回放既有签收；同投递已有 BOUND → 回放（不新增）。
   * 未送达（或所指尝试非送达态）抛 SignoffNotDeliveredError。
   */
  async resolveSignoff(
    em: EntityManager,
    input: ResolveSignoffInput,
  ): Promise<NotificationSignoff> {
    const {
      delivery,
      attemptNo,
      signoffKey,
      signer = null,
      channel = null,
      sourceReceiptId = null,
      signedAt = new Date(),
      bindToSpecifiedAttempt = true,
    } = input;

    // 幂等：同签收键回放
    const byKey = await em.findOne(NotificationSignoff, {
      where: { signoffKey },
    });
    if (byKey) return byKey;

    // 同投递已有有效签收：重复签收不新增
    const bound = await em.findOne(NotificationSignoff, {
      where: { deliveryId: delivery.id, state: SignoffState.BOUND },
    });
    if (bound) return bound;

    const anchor = await em.findOne(NotificationRecord, {
      where: { id: delivery.anchorNotificationId },
    });

    const staleByVersion =
      !anchor || !anchor.isCurrentVersion || anchor.supersededById != null;

    if (staleByVersion) {
      // 告知内容已被新版本替代：旧版迟到签收只能留痕
      return this.saveSignoffRow(em, {
        delivery,
        attemptNo,
        signoffKey,
        signer,
        channel,
        sourceReceiptId,
        signedAt,
        state: SignoffState.STALE_TRACE,
        traceNote:
          `告知内容已被新版本（${anchor?.supersededById ?? '?'}）替代：` +
          `旧版本 v${delivery.contentVersion} 的迟到签收不绑定有效签收，仅留痕`,
        deliveredReceiptId: null,
      });
    }

    // SIGNED 回执：必须绑定到家属实际签收的那条尝试；
    // 显式签收接口：按投递当前最终送达尝试（winningAttemptNo）绑定
    const targetAttemptNo = bindToSpecifiedAttempt
      ? attemptNo
      : delivery.winningAttemptNo;
    const targetAttempt =
      targetAttemptNo != null
        ? await em.findOne(NotificationRecord, {
            where: {
              stableDeliveryNo: delivery.stableDeliveryNo,
              attemptNo: targetAttemptNo,
            },
          })
        : null;

    if (
      delivery.aggregateStatus !== NotificationStatus.DELIVERED ||
      !targetAttempt ||
      targetAttempt.status !== NotificationStatus.DELIVERED
    ) {
      // 未送达不得签收（“已发送/已受理”不构成签收前提）
      throw new SignoffNotDeliveredError(delivery.stableDeliveryNo);
    }

    const deliveredReceipt = await em.findOne(NotificationReceipt, {
      where: {
        stableDeliveryNo: delivery.stableDeliveryNo,
        attemptNo: targetAttempt.attemptNo,
        event: ReceiptEvent.DELIVERED,
      },
      order: { receivedAt: 'ASC' },
    });

    // 正常绑定：引用送达回执，闭环 投递→送达→签收 证据链
    return this.saveSignoffRow(em, {
      delivery,
      attemptNo: targetAttempt.attemptNo,
      signoffKey,
      signer,
      channel,
      sourceReceiptId,
      signedAt,
      state: SignoffState.BOUND,
      traceNote: null,
      deliveredReceiptId: deliveredReceipt?.id ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /** 从全部尝试行重算聚合状态（乱序/迟到安全），并反映到锚点行 */
  private async recomputeAggregate(
    em: EntityManager,
    delivery: NotificationDelivery,
    channel: string | null,
    failureReason: string | null,
  ): Promise<void> {
    const attempts = await em.find(NotificationRecord, {
      where: { stableDeliveryNo: delivery.stableDeliveryNo },
      order: { attemptNo: 'ASC' },
    });

    let winner: NotificationRecord | null = null;
    let highestAccepted: NotificationRecord | null = null;
    for (const a of attempts) {
      if (
        a.status === NotificationStatus.DELIVERED ||
        a.status === NotificationStatus.FAILED
      ) {
        if (!winner || a.attemptNo > winner.attemptNo) winner = a;
      }
      if (a.status === NotificationStatus.ACCEPTED) {
        if (!highestAccepted || a.attemptNo > highestAccepted.attemptNo) {
          highestAccepted = a;
        }
      }
    }

    if (winner) {
      delivery.aggregateStatus = winner.status;
      delivery.winningAttemptNo = winner.attemptNo;
      delivery.aggregateAt = new Date();
      delivery.lastChannel =
        (channel as any) ?? winner.channel ?? delivery.lastChannel;
      delivery.lastFailureReason =
        winner.status === NotificationStatus.FAILED
          ? winner.failureReason ?? failureReason
          : null;
    } else if (highestAccepted) {
      delivery.aggregateStatus = NotificationStatus.ACCEPTED;
      delivery.winningAttemptNo = null;
      delivery.aggregateAt = new Date();
      delivery.lastChannel =
        (channel as any) ?? highestAccepted.channel ?? delivery.lastChannel;
    }
    await em.save(delivery);
    await this.reflectToAnchor(em, delivery);
  }

  /** 聚合状态反映到锚点行：只推进到更高阶段；送达后绝不回滚 */
  private async reflectToAnchor(
    em: EntityManager,
    delivery: NotificationDelivery,
  ): Promise<void> {
    const anchor = await em.findOne(NotificationRecord, {
      where: { id: delivery.anchorNotificationId },
    });
    if (!anchor) return;
    if (anchor.supersededById != null) return; // 已替代版本保持留痕状态
    if (anchor.status === NotificationStatus.DELIVERED) return; // 送达不可回滚

    if (delivery.aggregateStatus === NotificationStatus.DELIVERED) {
      anchor.status = NotificationStatus.DELIVERED;
      anchor.failureReason = null;
    } else if (
      delivery.aggregateStatus === NotificationStatus.ACCEPTED &&
      anchor.status === NotificationStatus.PENDING
    ) {
      anchor.status = NotificationStatus.ACCEPTED;
    } else if (delivery.aggregateStatus === NotificationStatus.FAILED) {
      // 锚点不降级为 FAILED：新尝试仍可送达；失败原因与次数仅作信息标注
      anchor.failureReason = delivery.lastFailureReason;
    }
    anchor.attempts = delivery.attemptCount;
    await em.save(anchor);
  }

  private async saveSignoffRow(
    em: EntityManager,
    data: {
      delivery: NotificationDelivery;
      attemptNo: number;
      signoffKey: string;
      signer: string | null;
      channel: string | null;
      sourceReceiptId: string | null;
      signedAt: Date;
      state: SignoffState;
      traceNote: string | null;
      deliveredReceiptId: string | null;
    },
  ): Promise<NotificationSignoff> {
    const row = new NotificationSignoff();
    row.signoffKey = data.signoffKey;
    row.stableDeliveryNo = data.delivery.stableDeliveryNo;
    row.attemptNo = data.attemptNo;
    row.contentVersion = data.delivery.contentVersion;
    row.contentHash = data.delivery.contentHash;
    row.state = data.state;
    row.traceNote = data.traceNote;
    row.signer = data.signer;
    row.channel = data.channel;
    row.signedAt = data.signedAt;
    row.delivery = data.delivery;
    row.deliveryId = data.delivery.id;
    row.deliveredReceiptId = data.deliveredReceiptId;
    row.sourceReceiptId = data.sourceReceiptId;
    return em.save(row);
  }

  /** 早到签收暂存为 STALE_TRACE 的“待处理”行（traceNote 带 PENDING 前缀） */
  private async queuePendingSignoff(
    em: EntityManager,
    data: {
      delivery: NotificationDelivery;
      attemptNo: number;
      signoffKey: string;
      signer: string | null;
      channel: string | null;
      sourceReceiptId: string | null;
      signedAt: Date;
    },
  ): Promise<NotificationSignoff> {
    // 已在队列中（同键）则回放
    const existed = await em.findOne(NotificationSignoff, {
      where: { signoffKey: data.signoffKey },
    });
    if (existed) return existed;
    return this.saveSignoffRow(em, {
      delivery: data.delivery,
      attemptNo: data.attemptNo,
      signoffKey: data.signoffKey,
      signer: data.signer,
      channel: data.channel,
      sourceReceiptId: data.sourceReceiptId,
      signedAt: data.signedAt,
      state: SignoffState.STALE_TRACE,
      traceNote:
        'PENDING：签收事件早于送达，暂存待送达后自动绑定（版本被替代则永久留痕）',
      deliveredReceiptId: null,
    });
  }

  /**
   * 送达后冲刷早到签收：
   * 家属在某条尝试上签收，则仅当该尝试已送达时闭环（重试内容快照相同，
   * 该尝试迟到送达仍可绑定其自身送达回执）；版本已替代则永久留痕。
   * deliveredAttemptNo 为本次刚送达的尝试序号。
   */
  private async flushPendingSignoffs(
    em: EntityManager,
    delivery: NotificationDelivery,
    deliveredAttemptNo: number,
  ): Promise<NotificationSignoff | null> {
    const pendings = await em.find(NotificationSignoff, {
      where: { deliveryId: delivery.id, state: SignoffState.STALE_TRACE },
    });
    const pending = pendings.filter((p) =>
      (p.traceNote ?? '').startsWith('PENDING'),
    );
    if (!pending.length) return null;

    const anchor = await em.findOne(NotificationRecord, {
      where: { id: delivery.anchorNotificationId },
    });
    const versionAlive =
      anchor && anchor.isCurrentVersion && anchor.supersededById == null;

    let bound: NotificationSignoff | null = null;
    for (const p of pending) {
      if (!versionAlive) {
        p.traceNote =
          '签收早于送达，送达前告知内容已被新版本替代：旧版本签收仅留痕，不绑定';
        await em.save(p);
        continue;
      }

      // 仅闭环“本次送达的尝试”上的早到签收
      if (p.attemptNo !== deliveredAttemptNo) continue;

      const targetAttempt = await em.findOne(NotificationRecord, {
        where: {
          stableDeliveryNo: delivery.stableDeliveryNo,
          attemptNo: deliveredAttemptNo,
        },
      });
      if (targetAttempt?.status !== NotificationStatus.DELIVERED) continue;

      const deliveredReceipt = await em.findOne(NotificationReceipt, {
        where: {
          stableDeliveryNo: delivery.stableDeliveryNo,
          attemptNo: deliveredAttemptNo,
          event: ReceiptEvent.DELIVERED,
        },
        order: { receivedAt: 'ASC' },
      });
      p.state = SignoffState.BOUND;
      p.traceNote = null;
      p.deliveredReceiptId = deliveredReceipt?.id ?? null;
      await em.save(p);
      bound = bound ?? p;
    }
    return bound;
  }
}

function isTerminalEvent(event: ReceiptEvent): boolean {
  return event === ReceiptEvent.DELIVERED || event === ReceiptEvent.FAILED;
}
