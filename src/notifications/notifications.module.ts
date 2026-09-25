import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssessmentCase } from '../entities/assessment-case.entity';
import { NotificationRecord } from '../entities/notification.entity';
import { NotificationDelivery } from '../entities/notification-delivery.entity';
import { NotificationReceipt } from '../entities/notification-receipt.entity';
import { NotificationSignoff } from '../entities/notification-signoff.entity';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotifyChannelService } from './notify-channel.service';
import { DeliveryStateService } from './delivery-state.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AssessmentCase,
      NotificationRecord,
      NotificationDelivery,
      NotificationReceipt,
      NotificationSignoff,
    ]),
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotifyChannelService,
    DeliveryStateService,
  ],
  exports: [NotificationsService, DeliveryStateService, NotifyChannelService],
})
export class NotificationsModule {}
