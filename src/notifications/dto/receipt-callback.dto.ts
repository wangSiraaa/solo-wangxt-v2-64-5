import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { DeliveryChannel, ReceiptEvent } from '../../common/enums';

/**
 * 离线投递器异步回传回执。
 * 回执允许重复（receiptEventId 去重）、乱序、在重试后迟到；
 * 服务端按 stableDeliveryNo + attemptNo 归并，旧尝试不覆盖新尝试最终状态。
 */
export class ReceiptCallbackDto {
  @ApiProperty({ description: '稳定投递号（发起投递时返回）' })
  @IsString()
  @MaxLength(32)
  stableDeliveryNo: string;

  @ApiProperty({ description: '回执针对的尝试序号', minimum: 1 })
  @IsInt()
  @Min(1)
  attemptNo: number;

  @ApiProperty({
    description: '渠道幂等事件号；相同事件号重复回传不新增结果',
  })
  @IsString()
  @MaxLength(128)
  receiptEventId: string;

  @ApiProperty({ enum: ReceiptEvent })
  @IsEnum(ReceiptEvent)
  event: ReceiptEvent;

  @ApiPropertyOptional({ enum: DeliveryChannel })
  @IsOptional()
  @IsEnum(DeliveryChannel)
  channel?: DeliveryChannel;

  @ApiPropertyOptional({ description: '失败原因（FAILED 时）' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  failureReason?: string;

  @ApiPropertyOptional({ description: '渠道声称的事件发生时间（可迟到/乱序）' })
  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  @ApiPropertyOptional({ description: 'SIGNED 事件的家属签收幂等键' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  signoffKey?: string;

  @ApiPropertyOptional({ description: 'SIGNED 事件的家属确认人' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  signer?: string;
}
