import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { NotifyChannel, ReceiptType } from '../../common/enums';

const CHANNELS = Object.values(NotifyChannel);
const RECEIPT_TYPES = Object.values(ReceiptType);

/** 发起投递：为既有告知记录创建第一次（或新内容版本的第一次）投递 */
export class CreateDeliveryDto {
  /** 目标告知记录；缺省取该案件最新一条告知记录 */
  @IsOptional()
  @IsUUID()
  notificationId?: string;

  /** 离线模拟投递通道，默认 SMS */
  @IsOptional()
  @IsIn(CHANNELS)
  channel?: NotifyChannel;

  /** 幂等键：重复投递请求按同键回放，不生成新投递 */
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

/** 失败重试：基于最新失败尝试创建下一次投递（新投递号、新尝试序号） */
export class RetryDeliveryDto {
  @IsOptional()
  @IsIn(CHANNELS)
  channel?: NotifyChannel;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

/** 家属签收：只能绑定已送达尝试的明确内容版本 */
export class SignDeliveryDto {
  @IsString()
  @IsNotEmpty()
  signer: string;

  /** 签收时间（ISO8601），缺省取服务端时间 */
  @IsOptional()
  @IsISO8601()
  signedAt?: string;

  /** 幂等事件 ID；缺省由服务端生成 */
  @IsOptional()
  @IsString()
  eventId?: string;
}

/** 内容刷新：按案件当前状态重新生成告知内容，内容变化时版本 +1 */
export class RefreshContentDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

/** 投递器回执事件（离线模拟多渠道投递器异步回传） */
export class ReceiptEventDto {
  /** 投递器事件 ID：幂等键，重复回传不新增结果 */
  @IsString()
  @IsNotEmpty()
  eventId: string;

  /** 稳定投递号 */
  @IsString()
  @IsNotEmpty()
  deliveryNo: string;

  @IsIn(RECEIPT_TYPES)
  type: ReceiptType;

  /** 事件发生时间（ISO8601），缺省取服务端接收时间 */
  @IsOptional()
  @IsISO8601()
  occurredAt?: string;

  /** 失败原因等说明 */
  @IsOptional()
  @IsString()
  reason?: string;

  /** 签收人（type=SIGNED 时） */
  @IsOptional()
  @IsString()
  signer?: string;
}

/** 批量回执归并：同一批次在单个事务内处理，任一失败整批回滚 */
export class IngestReceiptsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReceiptEventDto)
  receipts: ReceiptEventDto[];
}
