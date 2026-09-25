import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { DeliveryService } from './delivery.service';
import { RetryDeliveryDto, SignDeliveryDto } from './dto/delivery.dto';

/** 投递号维度：证据链查询、失败重试、家属签收 */
@Controller('notification/deliveries')
export class DeliveriesController {
  constructor(private readonly deliveries: DeliveryService) {}

  /** 完整证据链：投递快照 + 全部回执 + 签收 + 所属告知记录 */
  @Get(':deliveryNo')
  evidence(@Param('deliveryNo') deliveryNo: string) {
    return this.deliveries.evidence(deliveryNo);
  }

  /** 失败重试：仅最新失败尝试可重试，生成新投递号与新尝试序号 */
  @Post(':deliveryNo/retry')
  retry(
    @Param('deliveryNo') deliveryNo: string,
    @Body() dto: RetryDeliveryDto,
  ) {
    return this.deliveries.retry(deliveryNo, dto);
  }

  /** 家属签收：只能绑定已送达尝试的明确内容版本；重复签收幂等回放 */
  @Post(':deliveryNo/sign')
  sign(@Param('deliveryNo') deliveryNo: string, @Body() dto: SignDeliveryDto) {
    return this.deliveries.sign(deliveryNo, dto);
  }
}
