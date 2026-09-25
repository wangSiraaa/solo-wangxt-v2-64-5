import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { NotifyAttemptDto } from './dto/notify-attempt.dto';
import { RetryDeliveryDto } from './dto/retry-delivery.dto';
import { ReceiptCallbackDto } from './dto/receipt-callback.dto';
import { SignoffDto } from './dto/signoff.dto';
import { RenotifyDto } from './dto/renotify.dto';

@ApiTags('家属告知与回执签收')
@Controller('assessments/:caseId/notification')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  /** 发起一次家属告知投递：新稳定投递号 + 尝试序号 1，并固化内容快照 */
  @ApiOperation({
    summary: '发起家属告知投递（确认案件）或未确认尝试（兼容历史）',
  })
  @Post('attempt')
  attempt(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Body() dto: NotifyAttemptDto,
  ) {
    return this.service.attempt(caseId, dto);
  }

  /** 失败后按策略重试：同稳定投递号，尝试序号 +1（内容快照不变） */
  @ApiOperation({
    summary: '失败重试：同稳定投递号下新建尝试（attemptNo+1）',
  })
  @ApiConflictResponse({ description: '投递已送达时拒绝重试（重复送达不新增）' })
  @Post('deliveries/:stableDeliveryNo/retry')
  retry(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('stableDeliveryNo') stableDeliveryNo: string,
    @Body() dto: RetryDeliveryDto,
  ) {
    return this.service.retry(caseId, stableDeliveryNo, dto);
  }

  /** 离线投递器异步回执：受理/送达/失败/签收（可重复、乱序、迟到） */
  @ApiOperation({
    summary: '投递器回执回调（幂等去重、乱序归并、旧尝试迟到不覆盖新尝试）',
  })
  @Post('receipts')
  receipt(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Body() dto: ReceiptCallbackDto,
  ) {
    return this.service.receiveReceipt(caseId, dto);
  }

  /** 家属签收：仅绑定已送达的当前内容版本；旧版本迟到签收仅留痕 */
  @ApiOperation({ summary: '家属显式签收（未送达/旧版本不形成有效签收）' })
  @ApiConflictResponse({ description: '投递未送达（已发送不等于送达）' })
  @Post('signoffs')
  signoff(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Body() dto: SignoffDto,
  ) {
    return this.service.signoff(caseId, dto);
  }

  /** 重新告知：确认内容生成新版本并替代旧版本（旧版迟到签收只留痕） */
  @ApiOperation({ summary: '重新告知：生成新内容版本并替代当前版本' })
  @Post('renotify')
  renotify(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Body() dto: RenotifyDto,
  ) {
    return this.service.renotify(caseId, dto);
  }

  /** 单投递证据链：聚合状态、每次尝试、全部回执、签收 */
  @ApiOperation({ summary: '投递详情与证据链' })
  @ApiParam({ name: 'stableDeliveryNo', description: '稳定投递号' })
  @ApiNotFoundResponse({ description: '投递不存在' })
  @Get('deliveries/:stableDeliveryNo')
  delivery(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('stableDeliveryNo') stableDeliveryNo: string,
  ) {
    return this.service.getDelivery(caseId, stableDeliveryNo);
  }

  /** 告知时间线：版本创建 → 投递尝试 → 回执 → 签收 */
  @ApiOperation({ summary: '案件告知/投递/回执/签收统一时间线' })
  @Get('timeline')
  timeline(@Param('caseId', new ParseUUIDPipe()) caseId: string) {
    return this.service.timeline(caseId);
  }

  /** 查看该案件全部告知记录（兼容历史：锚点 + 每次尝试的扁平列表） */
  @ApiOperation({
    summary: '全部告知记录（历史兼容：失败历史、未确认尝试均保留）',
  })
  @ApiOkResponse({ description: '按时间升序的告知/尝试行列表' })
  @Get()
  list(@Param('caseId', new ParseUUIDPipe()) caseId: string) {
    return this.service.listForCase(caseId);
  }
}
