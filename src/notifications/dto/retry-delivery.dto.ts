import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { DeliveryChannel } from '../../common/enums';
import { NotifyAttemptDto } from './notify-attempt.dto';

export class RetryDeliveryDto implements Pick<NotifyAttemptDto, 'simulateFail' | 'channel' | 'asyncMode'> {
  @ApiPropertyOptional({ description: '强制本次重试失败（模拟通道异常）' })
  @IsOptional()
  @IsBoolean()
  simulateFail?: boolean;

  @ApiPropertyOptional({
    enum: DeliveryChannel,
    description: '重试渠道，默认沿用上一次渠道（离线模拟）',
  })
  @IsOptional()
  @IsEnum(DeliveryChannel)
  channel?: DeliveryChannel;

  @ApiPropertyOptional({
    description: '异步模式：仅受理，送达/失败等待回执回传',
  })
  @IsOptional()
  @IsBoolean()
  asyncMode?: boolean;
}
