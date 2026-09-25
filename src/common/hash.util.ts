import { createHash } from 'crypto';

/** 告知内容指纹：投递快照与签收绑定同一哈希，保证“签收的就是送达的内容” */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
