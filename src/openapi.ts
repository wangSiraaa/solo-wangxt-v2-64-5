import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * OpenAPI 文档挂载（main.ts 与 e2e 测试共用同一配置）。
 * 文档路径：/api/docs（UI）与 /api/docs/openapi.json（JSON）。
 */
export function setupOpenApi(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('养老评估-复核-告知-费用生效 流程 API')
    .setDescription(
      '虚构量表 DEMO_ADL 的行政流程演示（非医疗诊断）。' +
        '家属告知由离线模拟多渠道投递器异步回传受理/送达/失败/签收事件，' +
        '服务端保存不可变内容快照、稳定投递号与尝试序号，' +
        '回执按状态机归并（可重复/乱序/迟到），签收仅绑定已送达的当前内容版本。',
    )
    .setVersion('1.1.0')
    .addTag('家属告知与回执签收')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs/openapi.json',
  });
}
