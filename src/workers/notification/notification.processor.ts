import { Injectable, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { NotificationService } from './notification.service';

@Injectable()
export class NotificationProcessor implements OnApplicationBootstrap {
  private readonly logger = new Logger('NotificationProcessor');

  constructor(private notificationService: NotificationService) {}

  async onApplicationBootstrap(): Promise<void> {
    this.logger.log('⚡ Bootstrapping Notification Worker');
    await this.notificationService.start();
  }
}
