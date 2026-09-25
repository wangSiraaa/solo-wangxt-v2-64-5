import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { AssessmentCase } from '../entities/assessment-case.entity';
import { NotificationRecord } from '../entities/notification.entity';
import { NotificationDelivery } from '../entities/notification-delivery.entity';
import { NotificationReceipt } from '../entities/notification-receipt.entity';
import { NotificationSignature } from '../entities/notification-signature.entity';
import { NotificationContentVersion } from '../entities/notification-content-version.entity';
import {
  CaseStatus,
  DeliveryStatus,
  NotifiableStatus,
  NotifyChannel,
  ReceiptType,
} from '../common/enums';
import { contentHash } from '../common/hash.util';
import { buildFamilyNoticeText } from '../common/notice-text.util';
import {
  CreateDeliveryDto,
  RefreshContentDto,
  RetryDeliveryDto,
  SignDeliveryDto,
} from './dto/delivery.dto';
import { ReceiptsService } from './receipts.service';

export interface TimelineItem {
  seq: number;
  at: string;
  type: string;
  summary: string;
  notificationId?: string;
  deliveryNo?: string;
  attemptNo?: number;
  contentVersion?: number;
  applied?: boolean;
  detail?: Record<string, unknown>;
}

/**
 * 投递 / 重试 / 内容版本 / 签收 / 时间线。
 * 等级是否生效仍按机构规则（fees 模块）独立判断：
 * 本服务只保证“告知内容可靠送达并被签收”，绝不把“已发送/已送达”当作“等级已确认”。
 */
@Injectable()
export class DeliveryService {
  constructor(
    @InjectRepository(AssessmentCase)
    private readonly caseRepo: Repository<AssessmentCase>,
    @InjectRepository(NotificationRecord)
    private readonly notifRepo: Repository<NotificationRecord>,
    @InjectRepository(NotificationDelivery)
    private readonly deliveryRepo: Repository<NotificationDelivery>,
    @InjectRepository(NotificationContentVersion)
    private readonly versionRepo: Repository<NotificationContentVersion>,
    @InjectRepository(NotificationReceipt)
    private readonly receiptRepo: Repository<NotificationReceipt>,
    @InjectRepository(NotificationSignature)
    private readonly signatureRepo: Repository<NotificationSignature>,
    private readonly dataSource: DataSource,
    private readonly receipts: ReceiptsService,
  ) {}

  /**
   * 发起投递：为告知记录创建一次投递尝试。
   *  - 每次投递保存不可变内容快照、稳定投递号（DN-…）与尝试序号；
   *  - 同一内容版本已有投递 → 409（失败请用重试接口）；
   *  - 内容被新版本替代后，允许为新版本发起新的首次投递；
   *  - idempotencyKey 重复提交 → 幂等回放。
   */
  async createDelivery(caseId: string, dto: CreateDeliveryDto) {
    const assessmentCase = await this.caseRepo.findOne({ where: { id: caseId } });
    if (!assessmentCase) throw new NotFoundException('评估案件不存在');

    const notification = dto.notificationId
      ? await this.notifRepo.findOne({
          where: { id: dto.notificationId, assessmentCase: { id: caseId } },
        })
      : await this.notifRepo.findOne({
          where: { assessmentCase: { id: caseId } },
          order: { createdAt: 'DESC' },
        });
    if (!notification) {
      throw new ConflictException({
        code: 'NO_NOTIFICATION_RECORD',
        message: '该案件尚无告知记录可投递（等级确认后自动生成，或使用 attempt 接口先行尝试）',
      });
    }

    if (dto.idempotencyKey) {
      const dup = await this.deliveryRepo.findOne({
        where: { idempotencyKey: dto.idempotencyKey },
        relations: { notification: true },
      });
      if (dup) {
        return {
          replayed: true,
          message: '重复投递请求已幂等回放，未生成新投递',
          delivery: this.toDeliveryView(dup),
        };
      }
    }

    try {
      return await this.dataSource.transaction(async (em) => {
        await em.query(
          'SELECT id FROM notification_records WHERE id = $1 FOR UPDATE',
          [notification.id],
        );
        const current = await em
          .getRepository(NotificationRecord)
          .findOneByOrFail({ id: notification.id });

        const existing = await em.getRepository(NotificationDelivery).find({
          where: { notification: { id: notification.id } },
          order: { attemptNo: 'DESC' },
        });
        const latest = existing[0] ?? null;
        if (latest && latest.contentVersion === current.contentVersion) {
          throw new ConflictException({
            code: 'DELIVERY_EXISTS_USE_RETRY',
            message:
              `当前内容版本 v${current.contentVersion} 已有投递 ${latest.deliveryNo}` +
              `（${latest.status}）：失败请调用重试接口，待回执请等待投递器回传`,
          });
        }

        await this.ensureInitialVersion(em, current);
        const delivery = await this.insertDelivery(
          em,
          current,
          (latest?.attemptNo ?? 0) + 1,
          dto.channel ?? NotifyChannel.SMS,
          dto.idempotencyKey ?? null,
        );
        await this.receipts.recomputeProjection(em, notification.id);

        return {
          replayed: false,
          delivery: this.toDeliveryView(delivery),
        };
      });
    } catch (e: any) {
      // 并发下同幂等键唯一约束：回放已有投递
      if (
        dto.idempotencyKey &&
        (e?.constraint === 'notification_deliveries_idempotency_key_key' ||
          /idempotency_key/.test(String(e?.detail ?? '')))
      ) {
        const dup = await this.deliveryRepo.findOne({
          where: { idempotencyKey: dto.idempotencyKey },
          relations: { notification: true },
        });
        if (dup) {
          return {
            replayed: true,
            message: '并发重复投递请求已幂等回放',
            delivery: this.toDeliveryView(dup),
          };
        }
      }
      throw e;
    }
  }

  /**
   * 失败重试：仅允许基于“最新的失败尝试”创建下一次投递。
   * 新尝试使用新投递号、递增尝试序号，并重新快照当前内容版本。
   */
  async retry(deliveryNo: string, dto: RetryDeliveryDto) {
    const delivery = await this.deliveryRepo.findOne({
      where: { deliveryNo },
      relations: { notification: true },
    });
    if (!delivery) throw new NotFoundException(`投递号 ${deliveryNo} 不存在`);
    const notificationId = delivery.notification.id;

    if (dto.idempotencyKey) {
      const dup = await this.deliveryRepo.findOne({
        where: { idempotencyKey: dto.idempotencyKey },
        relations: { notification: true },
      });
      if (dup) {
        return {
          replayed: true,
          message: '重复重试请求已幂等回放，未生成新投递',
          delivery: this.toDeliveryView(dup),
        };
      }
    }

    try {
      return await this.dataSource.transaction(async (em) => {
        await em.query(
          'SELECT id FROM notification_records WHERE id = $1 FOR UPDATE',
          [notificationId],
        );
        const current = await em
          .getRepository(NotificationRecord)
          .findOneByOrFail({ id: notificationId });
        const deliveries = await em.getRepository(NotificationDelivery).find({
          where: { notification: { id: notificationId } },
          order: { attemptNo: 'DESC' },
        });
        const latest = deliveries[0];
        if (!latest || latest.deliveryNo !== deliveryNo) {
          throw new ConflictException({
            code: 'ONLY_LATEST_RETRYABLE',
            message: '仅可基于该告知记录的最新一次投递发起重试',
          });
        }
        if (latest.status !== DeliveryStatus.FAILED) {
          throw new ConflictException({
            code: 'RETRY_REQUIRES_FAILURE',
            message: `仅失败的最新尝试可重试（当前 ${latest.status}）；已送达/待回执的尝试不得重试`,
          });
        }

        await this.ensureInitialVersion(em, current);
        const next = await this.insertDelivery(
          em,
          current,
          latest.attemptNo + 1,
          dto.channel ?? latest.channel,
          dto.idempotencyKey ?? null,
        );
        await this.receipts.recomputeProjection(em, notificationId);

        return {
          replayed: false,
          retryOf: deliveryNo,
          delivery: this.toDeliveryView(next),
        };
      });
    } catch (e: any) {
      // 并发下同幂等键唯一约束：回放已有重试投递
      if (
        dto.idempotencyKey &&
        (e?.constraint === 'notification_deliveries_idempotency_key_key' ||
          /idempotency_key/.test(String(e?.detail ?? '')))
      ) {
        const dup = await this.deliveryRepo.findOne({
          where: { idempotencyKey: dto.idempotencyKey },
          relations: { notification: true },
        });
        if (dup) {
          return {
            replayed: true,
            message: '并发重复重试请求已幂等回放',
            delivery: this.toDeliveryView(dup),
          };
        }
      }
      throw e;
    }
  }

  /**
   * 内容刷新：按案件当前状态重新生成告知内容。
   * 内容实际变化 → 版本 +1、旧版本登记留痕、旧版本有效签收降级为 SUPERSEDED；
   * 内容未变化 → refreshed=false，不产生新版本。
   */
  async refreshContent(
    caseId: string,
    notificationId: string,
    dto: RefreshContentDto,
  ) {
    const assessmentCase = await this.caseRepo.findOne({
      where: { id: caseId },
      relations: { scaleVersion: true, review: true },
    });
    if (!assessmentCase) throw new NotFoundException('评估案件不存在');

    return this.dataSource.transaction(async (em) => {
      await em.query(
        'SELECT id FROM notification_records WHERE id = $1 FOR UPDATE',
        [notificationId],
      );
      const notification = await em
        .getRepository(NotificationRecord)
        .findOne({ where: { id: notificationId }, relations: { assessmentCase: true } });
      if (!notification || notification.assessmentCase.id !== caseId) {
        throw new NotFoundException('告知记录不存在或不属于该案件');
      }

      const nextMessage = buildFamilyNoticeText({
        elderName: assessmentCase.elderName,
        scaleTitle: assessmentCase.scaleVersion.title,
        status: assessmentCase.status,
        confirmedGrade: assessmentCase.confirmedGrade,
        reviewComment: assessmentCase.review?.comment ?? null,
        reviewerId: assessmentCase.review?.reviewerId ?? null,
      });
      const nextNotifiable =
        assessmentCase.status === CaseStatus.CONFIRMED
          ? NotifiableStatus.CONFIRMED
          : NotifiableStatus.UNCONFIRMED;

      if (
        nextMessage === notification.message &&
        nextNotifiable === notification.notifiableStatus
      ) {
        return {
          refreshed: false,
          message: '内容与可告知状态未变化，未产生新版本',
          contentVersion: notification.contentVersion,
          notification,
        };
      }

      await this.ensureInitialVersion(em, notification);

      const previous = {
        version: notification.contentVersion,
        content: notification.message,
      };
      notification.message = nextMessage;
      notification.notifiableStatus = nextNotifiable;
      notification.contentVersion = previous.version + 1;
      await em.getRepository(NotificationRecord).save(notification);

      const version = new NotificationContentVersion();
      version.notification = notification;
      version.version = notification.contentVersion;
      version.content = nextMessage;
      version.contentHash = contentHash(nextMessage);
      version.reason = dto.reason ?? '内容刷新：按案件当前状态重新生成';
      await em.getRepository(NotificationContentVersion).save(version);

      // 旧版本的有效签收降级为留痕（不得视为已签收当前版本）
      await em.query(
        `UPDATE notification_signatures SET status = $1
          WHERE notification_id = $2 AND status = $3`,
        ['SUPERSEDED', notification.id, 'VALID'],
      );

      await this.receipts.recomputeProjection(em, notification.id);
      const updated = await em
        .getRepository(NotificationRecord)
        .findOneByOrFail({ id: notification.id });

      return {
        refreshed: true,
        previousVersion: previous.version,
        contentVersion: updated.contentVersion,
        notification: updated,
      };
    });
  }

  /**
   * 家属签收：走与投递器 SIGNED 回执完全相同的归并状态机，
   * 保证“只能绑定已送达的明确内容版本”“重复签收不新增结果”。
   */
  async sign(deliveryNo: string, dto: SignDeliveryDto) {
    const delivery = await this.deliveryRepo.findOne({
      where: { deliveryNo },
      relations: { notification: true },
    });
    if (!delivery) throw new NotFoundException(`投递号 ${deliveryNo} 不存在`);
    if (delivery.status !== DeliveryStatus.DELIVERED) {
      throw new ConflictException({
        code: 'NOT_DELIVERED',
        message: `告知尚未送达（当前 ${delivery.status}），家属签收只能绑定已送达的投递`,
      });
    }

    const eventId = dto.eventId ?? `SIGN-${uuidv4()}`;
    const [result] = await this.receipts.ingest([
      {
        eventId,
        deliveryNo,
        type: ReceiptType.SIGNED,
        signer: dto.signer,
        occurredAt: dto.signedAt,
      },
    ]);

    const signature = result.signatureId
      ? await this.signatureRepo.findOne({ where: { id: result.signatureId } })
      : null;
    return {
      replayed: result.replayed || !result.applied,
      note: result.note,
      notificationStatus: result.notificationStatus,
      signature: signature ? this.toSignatureView(signature) : null,
    };
  }

  /** 单条投递的完整证据链：投递快照 + 全部回执 + 签收 + 所属告知记录 */
  async evidence(deliveryNo: string) {
    const delivery = await this.deliveryRepo.findOne({
      where: { deliveryNo },
      relations: { notification: true },
    });
    if (!delivery) throw new NotFoundException(`投递号 ${deliveryNo} 不存在`);

    const [receipts, signature, notification] = await Promise.all([
      this.receiptRepo.find({
        where: { deliveryNo },
        order: { createdAt: 'ASC' },
      }),
      this.signatureRepo.findOne({ where: { deliveryNo } }),
      this.notifRepo.findOneByOrFail({ id: delivery.notification.id }),
    ]);

    return {
      delivery: this.toDeliveryView(delivery),
      receipts: receipts.map((r) => this.toReceiptView(r)),
      signature: signature ? this.toSignatureView(signature) : null,
      notification: {
        id: notification.id,
        status: notification.status,
        notifiableStatus: notification.notifiableStatus,
        contentVersion: notification.contentVersion,
        message: notification.message,
        failureReason: notification.failureReason,
        attempts: notification.attempts,
      },
    };
  }

  /** 该案件全部投递尝试（按告知记录与尝试序号排序） */
  async listDeliveries(caseId: string) {
    const notifications = await this.notifRepo.find({
      where: { assessmentCase: { id: caseId } },
      order: { createdAt: 'ASC' },
    });
    if (notifications.length === 0) return [];
    const deliveries = await this.deliveryRepo.find({
      where: { notification: { id: In(notifications.map((n) => n.id)) } },
      relations: { notification: true },
      order: { createdAt: 'ASC' },
    });
    return deliveries.map((d) => this.toDeliveryView(d));
  }

  /**
   * 时间线：告知创建、内容版本、投递、回执（含未生效留痕）、签收，
   * 按发生时间归并排序（同一事务内的事件按类别稳定排序）。
   */
  async timeline(caseId: string): Promise<{ caseId: string; items: TimelineItem[] }> {
    const notifications = await this.notifRepo.find({
      where: { assessmentCase: { id: caseId } },
      order: { createdAt: 'ASC' },
    });
    const items: TimelineItem[] = [];
    if (notifications.length === 0) return { caseId, items };

    const ids = notifications.map((n) => n.id);
    const [versions, deliveries, signatures] = await Promise.all([
      this.versionRepo.find({
        where: { notification: { id: In(ids) } },
        relations: { notification: true },
      }),
      this.deliveryRepo.find({
        where: { notification: { id: In(ids) } },
        relations: { notification: true },
      }),
      this.signatureRepo.find({
        where: { notification: { id: In(ids) } },
        relations: { notification: true },
      }),
    ]);
    const receipts = deliveries.length
      ? await this.receiptRepo.find({
          where: { deliveryNo: In(deliveries.map((d) => d.deliveryNo)) },
        })
      : [];

    for (const n of notifications) {
      items.push({
        seq: 0,
        at: n.createdAt.toISOString(),
        type: 'NOTIFICATION_CREATED',
        notificationId: n.id,
        contentVersion: n.contentVersion,
        summary: `告知记录创建（可告知状态 ${n.notifiableStatus}）`,
        detail: { status: n.status, message: n.message },
      });
    }
    for (const v of versions) {
      items.push({
        seq: 0,
        at: v.createdAt.toISOString(),
        type: 'CONTENT_VERSION',
        notificationId: v.notification.id,
        contentVersion: v.version,
        summary:
          v.version === 1
            ? '内容版本 v1 建档（不可变留存）'
            : `内容更新为 v${v.version}，旧版本仅可留痕`,
        detail: { contentHash: v.contentHash, reason: v.reason },
      });
    }
    for (const d of deliveries) {
      items.push({
        seq: 0,
        at: d.createdAt.toISOString(),
        type: 'DELIVERY_CREATED',
        deliveryNo: d.deliveryNo,
        attemptNo: d.attemptNo,
        contentVersion: d.contentVersion,
        summary:
          `投递 ${d.deliveryNo}：第 ${d.attemptNo} 次尝试，` +
          `通道 ${d.channel}，内容版本 v${d.contentVersion}（快照不可变）`,
        detail: { contentHash: d.contentHash, notifiableStatus: d.notifiableStatus },
      });
    }
    for (const r of receipts) {
      items.push({
        seq: 0,
        at: r.createdAt.toISOString(),
        type: `RECEIPT_${r.type}`,
        deliveryNo: r.deliveryNo,
        attemptNo: r.attemptNo,
        applied: r.applied,
        summary: r.note ?? `回执 ${r.type}`,
        detail: {
          eventId: r.eventId,
          occurredAt: r.occurredAt.toISOString(),
          reason: r.reason,
        },
      });
    }
    for (const s of signatures) {
      items.push({
        seq: 0,
        at: s.createdAt.toISOString(),
        type: 'SIGNATURE',
        notificationId: s.notification.id,
        deliveryNo: s.deliveryNo,
        attemptNo: s.attemptNo,
        contentVersion: s.contentVersion,
        summary:
          s.status === 'VALID'
            ? `家属 ${s.signer} 签收生效（绑定内容版本 v${s.contentVersion}）`
            : `家属 ${s.signer} 对旧版 v${s.contentVersion} 的签收仅留痕（内容已被替代）`,
        detail: {
          signer: s.signer,
          signedAt: s.signedAt.toISOString(),
          status: s.status,
          contentHash: s.contentHash,
        },
      });
    }

    // 稳定排序：同时间戳保持插入类别顺序（创建→版本→投递→回执→签收）
    items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    items.forEach((item, idx) => {
      item.seq = idx + 1;
    });
    return { caseId, items };
  }

  // ---------------------------------------------------------------------------

  /** 首次接触某告知记录时回溯登记 v1（兼容迁移前已存在的记录） */
  private async ensureInitialVersion(
    em: EntityManager,
    notification: NotificationRecord,
  ): Promise<void> {
    const existing = await em.getRepository(NotificationContentVersion).findOne({
      where: { notification: { id: notification.id }, version: 1 },
    });
    if (existing || !notification.message) return;
    const v1 = new NotificationContentVersion();
    v1.notification = notification;
    v1.version = 1;
    v1.content = notification.message;
    v1.contentHash = contentHash(notification.message);
    v1.reason = '初始内容（回溯建档）';
    await em.getRepository(NotificationContentVersion).save(v1);
  }

  private async insertDelivery(
    em: EntityManager,
    notification: NotificationRecord,
    attemptNo: number,
    channel: NotifyChannel,
    idempotencyKey: string | null,
  ): Promise<NotificationDelivery> {
    const [{ nextval }] = await em.query(
      `SELECT nextval('notification_delivery_no_seq') AS nextval`,
    );
    const delivery = new NotificationDelivery();
    delivery.notification = notification;
    delivery.deliveryNo = `DN-${String(nextval).padStart(6, '0')}`;
    delivery.attemptNo = attemptNo;
    delivery.channel = channel;
    delivery.status = DeliveryStatus.PENDING;
    delivery.notifiableStatus = notification.notifiableStatus;
    delivery.contentVersion = notification.contentVersion;
    delivery.contentSnapshot = notification.message ?? '';
    delivery.contentHash = contentHash(delivery.contentSnapshot);
    delivery.idempotencyKey = idempotencyKey;
    delivery.failureReason = null;
    return em.getRepository(NotificationDelivery).save(delivery);
  }

  private toDeliveryView(d: NotificationDelivery) {
    return {
      id: d.id,
      notificationId: d.notification?.id ?? null,
      deliveryNo: d.deliveryNo,
      attemptNo: d.attemptNo,
      channel: d.channel,
      status: d.status,
      notifiableStatus: d.notifiableStatus,
      contentVersion: d.contentVersion,
      contentSnapshot: d.contentSnapshot,
      contentHash: d.contentHash,
      failureReason: d.failureReason,
      acceptedAt: d.acceptedAt,
      deliveredAt: d.deliveredAt,
      failedAt: d.failedAt,
      createdAt: d.createdAt,
    };
  }

  private toReceiptView(r: NotificationReceipt) {
    return {
      id: r.id,
      eventId: r.eventId,
      deliveryNo: r.deliveryNo,
      attemptNo: r.attemptNo,
      type: r.type,
      applied: r.applied,
      note: r.note,
      reason: r.reason,
      signer: r.signer,
      occurredAt: r.occurredAt,
      receivedAt: r.createdAt,
    };
  }

  private toSignatureView(s: NotificationSignature) {
    return {
      id: s.id,
      eventId: s.eventId,
      deliveryNo: s.deliveryNo,
      attemptNo: s.attemptNo,
      contentVersion: s.contentVersion,
      contentHash: s.contentHash,
      signer: s.signer,
      status: s.status,
      signedAt: s.signedAt,
      createdAt: s.createdAt,
    };
  }
}
