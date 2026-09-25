import { Controller, Get, Header } from '@nestjs/common';
import { openApiSpec } from './openapi-spec';

/** OpenAPI 描述（JSON），单一事实来源见 src/openapi/openapi-spec.ts */
@Controller()
export class OpenapiController {
  @Get('openapi.json')
  @Header('Content-Type', 'application/json; charset=utf-8')
  document() {
    return openApiSpec;
  }
}
