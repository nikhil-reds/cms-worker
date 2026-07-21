import { Injectable, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { SchedulerQueueService } from './scheduler-queue.service';
import { SchedulerEventConsumerService } from './scheduler-event-consumer.service';
import { PlayerWebSocketGatewayService } from './player-websocket-gateway.service';

@Injectable()
export class SchedulerProcessor implements OnApplicationBootstrap {
  private readonly logger = new Logger('SchedulerProcessor');

  constructor(
    private schedulerService: SchedulerService,
    private schedulerQueue: SchedulerQueueService,
    private schedulerEventConsumer: SchedulerEventConsumerService,
    private playerWebSocketGateway: PlayerWebSocketGatewayService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.logger.log('⚡ Bootstrapping Scheduler Worker');
    await this.schedulerService.start();
    await this.playerWebSocketGateway.start();
    await this.schedulerQueue.start();
    await this.schedulerEventConsumer.start();
  }
}
