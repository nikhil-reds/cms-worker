import { Injectable, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

@Injectable()
export class AnalyticsProcessor implements OnApplicationBootstrap {
  private readonly logger = new Logger('AnalyticsProcessor');

  constructor(private analyticsService: AnalyticsService) {}

  async onApplicationBootstrap(): Promise<void> {
    this.logger.log('⚡ Bootstrapping Analytics Worker');
    await this.analyticsService.start();
  }
}
