/**
 * 一次性生成仓库根目录 openapi.yaml（src/openapi/openapi-spec.ts 的 YAML 镜像）。
 * 用法：npx ts-node src/openapi/export-yaml.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { openApiSpec } from './openapi-spec';

/** 极简 YAML 序列化（仅覆盖本 spec 用到的类型：对象/数组/字符串/数字/布尔） */
function toYaml(value: unknown, indent: number): string {
  const pad = '  '.repeat(indent);
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'string') {
    if (value === '' || /[:#\[\]{}&*!|>'"%@`,?]|\s$|^\s/.test(value)) {
      return JSON.stringify(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value
      .map((item) => {
        const rendered = toYaml(item, indent + 1);
        if (typeof item === 'object' && item !== null) {
          return `${pad}-\n${rendered}`;
        }
        return `${pad}- ${rendered}`;
      })
      .join('\n');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '{}';
  return entries
    .map(([k, v]) => {
      const key = /^[A-Za-z0-9_./{}\-]+$/.test(k) ? k : JSON.stringify(k);
      const rendered = toYaml(v, indent + 1);
      if (typeof v === 'object' && v !== null && rendered !== '[]' && rendered !== '{}') {
        return `${pad}${key}:\n${rendered}`;
      }
      return `${pad}${key}: ${rendered}`;
    })
    .join('\n');
}

const yaml =
  '# 本文件由 src/openapi/openapi-spec.ts 生成（npx ts-node src/openapi/export-yaml.ts），\n' +
  '# 与 GET /api/openapi.json 内容一致；请勿手工编辑。\n' +
  toYaml(openApiSpec, 0) +
  '\n';

fs.writeFileSync(path.resolve(process.cwd(), 'openapi.yaml'), yaml, 'utf8');
// eslint-disable-next-line no-console
console.log('openapi.yaml written');
