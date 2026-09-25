import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { DeliveryService } from './delivery.service';
import {
  CreateDeliveryDto,
  RefreshContentDto,
} from './dto/delivery.dto';

/** 案件维度：投递发起、投递列表、内容刷新、时间线 */
@Controller('assessments/:caseId/notification')
export class CaseNotificationsController {
  constructor(private readonly deliveries: DeliveryService) {}

  /** 发起投递：为告知记录创建投递尝试（不可变快照 + 稳定投递号 + 尝试序号） */
  @Post('deliveries')
  createDelivery(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Body() dto: CreateDeliveryDto,
  ) {
    return this.deliveries.createDelivery(caseId, dto);
  }

  /** 该案件全部投递尝试（含每次尝试的状态与快照） */
  @Get('deliveries')
  listDeliveries(@Param('caseId', new ParseUUIDPipe()) caseId: string) {
    return this.deliveries.listDeliveries(caseId);
  }

  /** 时间线：告知创建 / 内容版本 / 投递 / 回执（含留痕）/ 签收 */
  @Get('timeline')
  timeline(@Param('caseId', new ParseUUIDPipe()) caseId: string) {
    return this.deliveries.timeline(caseId);
  }

  /** 内容刷新：按案件当前状态重新生成告知内容，内容变化时版本 +1 */
  @Post(':notificationId/refresh')
  refreshContent(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Param('notificationId', new ParseUUIDPipe()) notificationId: string,
    @Body() dto: RefreshContentDto,
  ) {
    return this.deliveries.refreshContent(caseId, notificationId, dto);
  }
}
