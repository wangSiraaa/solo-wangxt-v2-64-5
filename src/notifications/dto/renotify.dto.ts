import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * 重新告知：等级确认内容形成新版本（原内容版本被替代）。
 * 旧版本投递的送达/失败证据保留；旧版本的迟到签收只能留痕（STALE_TRACE）。
 */
export class RenotifyDto {
  @ApiPropertyOptional({ description: '新版本附加补充说明' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  supplement?: string;
}
