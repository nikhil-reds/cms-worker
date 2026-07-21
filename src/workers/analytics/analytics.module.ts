import { Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { AnalyticsProcessor } from './analytics.processor';

@Module({
  providers: [AnalyticsService, AnalyticsProcessor],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
