import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  DeliveryStatus,
  NotificationStatus,
  NotifiableStatus,
  ReceiptType,
  SignatureStatus,
} from '../common/enums';
import { NotificationRecord } from '../entities/notification.entity';
import { NotificationDelivery } from '../entities/notification-delivery.entity';
import { NotificationReceipt } from '../entities/notification-receipt.entity';
import { NotificationSignature } from '../entities/notification-signature.entity';
import { ReceiptEventDto } from './dto/delivery.dto';

export interface ReceiptMergeResult {
  eventId: string;
  deliveryNo: string;
  type: ReceiptType;
  /** 是否被状态机接受并产生效果（false=重复/迟到/无效，仅留痕） */
  applied: boolean;
  /** 是否为同 eventId 的重复回传（幂等回放，未新增任何记录） */
  replayed: boolean;
  note: string;
  /** 归并后告知记录的最新状态 */
  notificationStatus: NotificationStatus;
  signatureId: string | null;
}

/**
 * 回执归并状态机（可靠回执核心）。
 *
 * 语义约定：
 *  - 回执按“到达顺序”处理，不按投递器声称的 occurredAt 重排；
 *  - event_id 幂等：同一事件重复回传直接回放首次结果，不新增任何记录；
 *  - 单次尝试状态机 PENDING → ACCEPTED → DELIVERED / FAILED，终态粘滞：
 *    终态之后到达的回执（重复送达、重试后迟到的旧失败等）只留痕、不改变状态；
 *  - 告知记录级状态只由“最新一次投递尝试”投影得出：
 *    旧尝试的送达/失败永远不得覆盖新尝试的最终状态；
 *  - 家属签收只能绑定“已送达尝试”的明确内容版本；
 *    内容被新版本替代后，旧版迟到签收以 SUPERSEDED 留痕、不生效；
 *  - 全部写操作在单个数据库事务内完成：批次内任一失败，整批回滚，
 *    投递尝试、有效回执、签收与等级费用状态保持一致。
 */
@Injectable()
export class ReceiptsService {
  constructor(private readonly dataSource: DataSource) {}

  /** 批量归并回执：整批一个事务，任一失败全部回滚 */
  async ingest(events: ReceiptEventDto[]): Promise<ReceiptMergeResult[]> {
    return this.dataSource.transaction(async (em) => {
      const results: ReceiptMergeResult[] = [];
      for (const event of events) {
        results.push(await this.applyOne(em, event));
      }
      return results;
    });
  }

  /** 归并单条回执（在调用方事务内执行） */
  private async applyOne(
    em: EntityManager,
    event: ReceiptEventDto,
  ): Promise<ReceiptMergeResult> {
    // 幂等：同一 eventId 重复回传 → 回放首次归并结果，不新增任何记录
    const duplicate = await em.getRepository(NotificationReceipt).findOne({
      where: { eventId: event.eventId },
    });
    if (duplicate) {
      const dupDelivery = await em.getRepository(NotificationDelivery).findOne({
        where: { deliveryNo: duplicate.deliveryNo },
        relations: { notification: true },
      });
      const current = dupDelivery
        ? await em
            .getRepository(NotificationRecord)
            .findOneByOrFail({ id: dupDelivery.notification.id })
        : null;
      const existingSignature = await em
        .getRepository(NotificationSignature)
        .findOne({ where: { eventId: event.eventId } });
      return {
        eventId: event.eventId,
        deliveryNo: duplicate.deliveryNo,
        type: duplicate.type,
        applied: false,
        replayed: true,
        note: '重复回执：同一事件已归并，按幂等回放，不新增结果',
        notificationStatus: current?.status ?? NotificationStatus.PENDING,
        signatureId: existingSignature?.id ?? null,
      };
    }

    const delivery = await em.getRepository(NotificationDelivery).findOne({
      where: { deliveryNo: event.deliveryNo },
      relations: { notification: true },
    });
    if (!delivery) {
      throw new NotFoundException({
        code: 'DELIVERY_NOT_FOUND',
        message: `投递号 ${event.deliveryNo} 不存在，回执无法归并`,
      });
    }
    const notificationId = delivery.notification.id;

    // 行锁串行化同一告知记录的并发回执，保证归并顺序即到达顺序
    await em.query(
      'SELECT id FROM notification_records WHERE id = $1 FOR UPDATE',
      [notificationId],
    );

    // 锁内复查幂等：并发下同 eventId 在锁外检查后可能已提交，此处兜底回放
    const duplicateAfterLock = await em
      .getRepository(NotificationReceipt)
      .findOne({ where: { eventId: event.eventId } });
    if (duplicateAfterLock) {
      const current = await em
        .getRepository(NotificationRecord)
        .findOneByOrFail({ id: notificationId });
      const existingSignature = await em
        .getRepository(NotificationSignature)
        .findOne({ where: { eventId: event.eventId } });
      return {
        eventId: event.eventId,
        deliveryNo: duplicateAfterLock.deliveryNo,
        type: duplicateAfterLock.type,
        applied: false,
        replayed: true,
        note: '重复回执：同一事件已归并，按幂等回放，不新增结果',
        notificationStatus: current.status,
        signatureId: existingSignature?.id ?? null,
      };
    }

    const notification = await em
      .getRepository(NotificationRecord)
      .findOneByOrFail({ id: notificationId });

    const occurredAt = event.occurredAt ? new Date(event.occurredAt) : new Date();

    let applied = false;
    let note = '';
    let signature: NotificationSignature | null = null;

    if (event.type === ReceiptType.SIGNED) {
      const r = await this.applySigned(em, delivery, notification, event, occurredAt);
      applied = r.applied;
      note = r.note;
      signature = r.signature;
    } else {
      const r = this.applyDeliveryTransition(delivery, event, occurredAt);
      applied = r.applied;
      note = r.note;
      if (applied) {
        await em.getRepository(NotificationDelivery).save(delivery);
      }
    }

    // append-only 回执日志：无论是否生效都留痕（重复 eventId 除外，上面已拦截）
    const receipt = new NotificationReceipt();
    receipt.delivery = delivery;
    receipt.eventId = event.eventId;
    receipt.deliveryNo = delivery.deliveryNo;
    receipt.attemptNo = delivery.attemptNo;
    receipt.type = event.type;
    receipt.occurredAt = occurredAt;
    receipt.reason = event.reason ?? null;
    receipt.signer = event.signer ?? null;
    receipt.applied = applied;
    receipt.note = note;
    receipt.payload = { ...event };
    await em.getRepository(NotificationReceipt).save(receipt);

    // 告知记录级投影：只取最新尝试 + 当前版本有效签收
    const updated = await this.recomputeProjection(em, notificationId);

    return {
      eventId: event.eventId,
      deliveryNo: delivery.deliveryNo,
      type: event.type,
      applied,
      replayed: false,
      note,
      notificationStatus: updated.status,
      signatureId: signature?.id ?? null,
    };
  }

  /**
   * 单次尝试状态机：PENDING → ACCEPTED → DELIVERED / FAILED。
   * 终态（DELIVERED/FAILED）之后到达的回执仅留痕，不回滚状态。
   */
  private applyDeliveryTransition(
    delivery: NotificationDelivery,
    event: ReceiptEventDto,
    occurredAt: Date,
  ): { applied: boolean; note: string } {
    const terminal =
      delivery.status === DeliveryStatus.DELIVERED ||
      delivery.status === DeliveryStatus.FAILED;
    if (terminal) {
      return {
        applied: false,
        note:
          `尝试 #${delivery.attemptNo} 已终态（${delivery.status}），` +
          `${event.type} 回执仅留痕，不改变既有状态`,
      };
    }

    switch (event.type) {
      case ReceiptType.ACCEPTED:
        if (delivery.status === DeliveryStatus.ACCEPTED) {
          return { applied: false, note: '重复受理回执，仅留痕' };
        }
        delivery.status = DeliveryStatus.ACCEPTED;
        delivery.acceptedAt = occurredAt;
        return { applied: true, note: '通道已受理' };
      case ReceiptType.DELIVERED:
        delivery.status = DeliveryStatus.DELIVERED;
        delivery.deliveredAt = occurredAt;
        return { applied: true, note: '送达成功' };
      case ReceiptType.FAILED:
        delivery.status = DeliveryStatus.FAILED;
        delivery.failedAt = occurredAt;
        delivery.failureReason = event.reason ?? '通道未说明失败原因';
        return { applied: true, note: `投递失败：${delivery.failureReason}` };
      default:
        return { applied: false, note: `事件类型 ${event.type} 不改变投递状态` };
    }
  }

  /**
   * 签收归并：只能绑定已送达尝试的明确内容版本。
   * 内容已被新版本替代 → SUPERSEDED 留痕；重复签收 → 幂等回放。
   */
  private async applySigned(
    em: EntityManager,
    delivery: NotificationDelivery,
    notification: NotificationRecord,
    event: ReceiptEventDto,
    occurredAt: Date,
  ): Promise<{ applied: boolean; note: string; signature: NotificationSignature | null }> {
    if (delivery.status !== DeliveryStatus.DELIVERED) {
      return {
        applied: false,
        note: `签收无效：尝试 #${delivery.attemptNo} 尚未送达（${delivery.status}），不能绑定签收`,
        signature: null,
      };
    }

    const existing = await em.getRepository(NotificationSignature).findOne({
      where: { delivery: { id: delivery.id } },
    });
    if (existing) {
      return {
        applied: false,
        note: '重复签收：该投递已有签收记录，幂等回放，不新增结果',
        signature: existing,
      };
    }

    const isCurrent = delivery.contentVersion === notification.contentVersion;
    const signature = new NotificationSignature();
    signature.notification = notification;
    signature.delivery = delivery;
    signature.eventId = event.eventId;
    signature.deliveryNo = delivery.deliveryNo;
    signature.attemptNo = delivery.attemptNo;
    signature.contentVersion = delivery.contentVersion;
    signature.contentHash = delivery.contentHash;
    signature.signer = event.signer ?? '家属';
    signature.status = isCurrent
      ? SignatureStatus.VALID
      : SignatureStatus.SUPERSEDED;
    signature.signedAt = occurredAt;
    await em.getRepository(NotificationSignature).save(signature);

    return isCurrent
      ? {
          applied: true,
          note: `家属签收生效：绑定内容版本 v${delivery.contentVersion}`,
          signature,
        }
      : {
          applied: true,
          note:
            `内容已被新版本 v${notification.contentVersion} 替代，` +
            `旧版 v${delivery.contentVersion} 的迟到签收仅留痕，不生效`,
          signature,
        };
  }

  /**
   * 告知记录级状态投影（纯函数式重算，与回执到达顺序无关）：
   *  - 仅由“最新一次投递尝试”推导送达状态，旧尝试回执不得覆盖；
   *  - 当前内容版本存在有效签收 → SIGNED；
   *  - 同步 attempts / lastAttemptAt / failureReason，保持既有查询兼容。
   */
  async recomputeProjection(
    em: EntityManager,
    notificationId: string,
  ): Promise<NotificationRecord> {
    const notifRepo = em.getRepository(NotificationRecord);
    const notification = await notifRepo.findOneByOrFail({ id: notificationId });

    const deliveries = await em.getRepository(NotificationDelivery).find({
      where: { notification: { id: notificationId } },
      order: { attemptNo: 'ASC' },
    });
    if (deliveries.length === 0) return notification; // 无投递：保持既有状态（旧接口记录）

    const latest = deliveries[deliveries.length - 1];
    notification.attempts = deliveries.length;
    notification.lastAttemptAt = latest.createdAt;

    const validSignature = await em.getRepository(NotificationSignature).findOne({
      where: {
        notification: { id: notificationId },
        status: SignatureStatus.VALID,
      },
    });

    if (validSignature) {
      notification.status = NotificationStatus.SIGNED;
      notification.failureReason = null;
    } else if (latest.status === DeliveryStatus.DELIVERED) {
      notification.status = NotificationStatus.DELIVERED;
      notification.failureReason = null;
    } else if (latest.status === DeliveryStatus.FAILED) {
      notification.status = NotificationStatus.FAILED;
      notification.failureReason = latest.failureReason;
    } else {
      // PENDING / ACCEPTED：告知级仍为待送达
      notification.status = NotificationStatus.PENDING;
      notification.failureReason = null;
    }

    return notifRepo.save(notification);
  }
}
