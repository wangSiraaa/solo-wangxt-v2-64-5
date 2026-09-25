import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { DeliveryChannel } from '../../common/enums';

export class NotifyAttemptDto {
  /** 演示用：强制本次送达失败（模拟通道异常），记录失败原因 */
  @ApiPropertyOptional({ description: '强制本次投递失败（模拟通道异常）' })
  @IsOptional()
  @IsBoolean()
  simulateFail?: boolean;

  /** 指定投递渠道（离线模拟多渠道投递器） */
  @ApiPropertyOptional({
    enum: DeliveryChannel,
    description: '投递渠道，默认 SMS（离线模拟，不连接真实服务）',
  })
  @IsOptional()
  @IsEnum(DeliveryChannel)
  channel?: DeliveryChannel;

  /**
   * 异步模式：投递器仅回 ACCEPTED（已发送），送达/失败由回执接口异步回传。
   * 默认 false（兼容历史行为：受理后同步给出确定结果）。
   */
  @ApiPropertyOptional({
    description:
      '异步投递模式：仅受理（ACCEPTED，不代表送达），结果等待回执回传',
  })
  @IsOptional()
  @IsBoolean()
  asyncMode?: boolean;
}
