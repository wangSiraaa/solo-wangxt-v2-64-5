import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssessmentCase } from '../entities/assessment-case.entity';
import { NotificationRecord } from '../entities/notification.entity';
import { NotificationDelivery } from '../entities/notification-delivery.entity';
import { NotificationReceipt } from '../entities/notification-receipt.entity';
import { NotificationSignature } from '../entities/notification-signature.entity';
import { NotificationContentVersion } from '../entities/notification-content-version.entity';
import { NotificationsController } from './notifications.controller';
import { CaseNotificationsController } from './case-notifications.controller';
import { DeliveriesController } from './deliveries.controller';
import { ReceiptsController } from './receipts.controller';
import { NotificationsService } from './notifications.service';
import { NotifyChannelService } from './notify-channel.service';
import { DeliveryService } from './delivery.service';
import { ReceiptsService } from './receipts.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AssessmentCase,
      NotificationRecord,
      NotificationDelivery,
      NotificationReceipt,
      NotificationSignature,
      NotificationContentVersion,
    ]),
  ],
  controllers: [
    NotificationsController,
    CaseNotificationsController,
    DeliveriesController,
    ReceiptsController,
  ],
  providers: [
    NotificationsService,
    NotifyChannelService,
    DeliveryService,
    ReceiptsService,
  ],
})
export class NotificationsModule {}
