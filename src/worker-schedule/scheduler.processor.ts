import { Injectable, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';

@Injectable()
export class SchedulerProcessor implements OnApplicationBootstrap {
  private readonly logger = new Logger('SchedulerProcessor');

  constructor(private schedulerService: SchedulerService) {}

  async onApplicationBootstrap(): Promise<void> {
    this.logger.log('⚡ Bootstrapping Scheduler Worker');
    await this.schedulerService.start();
  }
}
