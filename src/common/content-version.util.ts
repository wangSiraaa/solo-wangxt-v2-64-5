import { NotificationContentVersion } from '../entities/notification-content-version.entity';
import { NotificationRecord } from '../entities/notification.entity';
import { contentHash } from './hash.util';

/** 告知记录创建时同步登记内容版本 v1（不可变留存，供投递快照与签收绑定） */
export function initialContentVersion(
  notification: NotificationRecord,
  reason: string,
): NotificationContentVersion {
  const v1 = new NotificationContentVersion();
  v1.notification = notification;
  v1.version = 1;
  v1.content = notification.message ?? '';
  v1.contentHash = contentHash(v1.content);
  v1.reason = reason;
  return v1;
}
