import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { DeliveryChannel } from '../../common/enums';

/** 家属显式签收（绑定已送达的当前内容版本；旧版本/未送达不形成有效签收） */
export class SignoffDto {
  @ApiProperty({ description: '稳定投递号' })
  @IsString()
  @MaxLength(32)
  stableDeliveryNo: string;

  @ApiProperty({ description: '签收幂等键；重复签收不新增结果' })
  @IsString()
  @MaxLength(128)
  signoffKey: string;

  @ApiPropertyOptional({ description: '家属确认人（签名）' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  signer?: string;

  @ApiPropertyOptional({ enum: DeliveryChannel, description: '签收渠道' })
  @IsOptional()
  @IsEnum(DeliveryChannel)
  channel?: DeliveryChannel;
}
