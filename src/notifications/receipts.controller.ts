import { Body, Controller, Post } from '@nestjs/common';
import { ReceiptsService } from './receipts.service';
import { IngestReceiptsDto } from './dto/delivery.dto';

/**
 * 投递器回执入口（离线模拟多渠道投递器的异步回传通道）。
 * 回执可能重复、乱序或迟到；同一批次在单个事务内归并，任一失败整批回滚。
 */
@Controller('notification/receipts')
export class ReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  @Post()
  async ingest(@Body() dto: IngestReceiptsDto) {
    const results = await this.receipts.ingest(dto.receipts);
    return { ingested: results.length, results };
  }
}
