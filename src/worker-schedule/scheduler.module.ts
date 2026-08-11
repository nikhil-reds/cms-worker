import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { SchedulerProcessor } from './scheduler.processor';
import { SchedulerDbService } from './scheduler-db.service';
import { PlayerConfigService } from '../workers/media-sync/player-config.service';
import { ManifestPublisherService } from './manifest-publisher.service';
import { SchedulerRedisService } from './scheduler-redis.service';
import { SchedulerEventsService } from './scheduler-events.service';
import { SchedulerQueueService } from './scheduler-queue.service';
import { SchedulerEventConsumerService } from './scheduler-event-consumer.service';
import { PlayerWebSocketGatewayService } from './player-websocket-gateway.service';

const PLAYER_ROOT = process.env.PLAYER_ROOT_PATH || '/Users/nikhil/Desktop/player';
const PLAYER_API_URL = (process.env.PLAYER_API_URL || '').replace(/\/$/, '');
const PLAYER_DEVICE_ID = process.env.PLAYER_DEVICE_ID || 'SL-PLAYER-001';
const PLAYER_MANIFEST_BUCKET =
  process.env.PLAYER_MANIFEST_BUCKET ||
  process.env.AWS_BUCKET_PLAYER_MANIFEST ||
  process.env.AWS_BUCKET_MEDIA_PROCESSED ||
  '';
const PLAYER_MANIFEST_KEY =
  process.env.PLAYER_MANIFEST_KEY || `manifests/${PLAYER_DEVICE_ID}.json`;
const PLAYER_CDN_URL =
  process.env.PLAYER_CDN_URL ||
  process.env.NEXT_PUBLIC_CDN_URL ||
  process.env.CLOUDFRONT_URL ||
  '';
const REDPANDA_BROKERS = (process.env.REDPANDA_BROKERS || 'localhost:29092')
  .split(',')
  .map((broker) => broker.trim())
  .filter(Boolean);

@Module({
  providers: [
    {
      provide: SchedulerDbService,
      useFactory: () => new SchedulerDbService(process.env.DATABASE_URL || ''),
    },
    {
      provide: PlayerConfigService,
      useFactory: () =>
        new PlayerConfigService(
          PLAYER_ROOT,
          PLAYER_API_URL,
          process.env.PLAYER_API_TOKEN || '',
        ),
    },
    {
      provide: ManifestPublisherService,
      useFactory: () =>
        new ManifestPublisherService(
          PLAYER_MANIFEST_BUCKET,
          PLAYER_MANIFEST_KEY,
          process.env.AWS_REGION || 'ap-south-1',
          process.env.AWS_ACCESS_KEY_ID || '',
          process.env.AWS_SECRET_ACCESS_KEY || '',
          process.env.PLAYER_MANIFEST_PUBLIC_BASE_URL || PLAYER_CDN_URL,
        ),
    },
    {
      provide: SchedulerRedisService,
      useFactory: () =>
        new SchedulerRedisService(
          process.env.REDIS_URL || 'redis://localhost:6379',
          process.env.REDIS_ENABLED !== 'false',
        ),
    },
    {
      provide: SchedulerEventsService,
      useFactory: () =>
        new SchedulerEventsService(
          REDPANDA_BROKERS,
          process.env.REDPANDA_CLIENT_ID || 'cms-worker-scheduler',
          process.env.REDPANDA_SCHEDULER_EVALUATION_TOPIC ||
            'scheduler.evaluation.completed',
          process.env.REDPANDA_PLAYER_MANIFEST_PUBLISHED_TOPIC ||
            'player.manifest.published',
          process.env.REDPANDA_PLAYER_UPDATE_FAILED_TOPIC ||
            'player.update.failed',
          process.env.REDPANDA_ENABLED !== 'false',
        ),
    },
    {
      provide: SchedulerService,
      useFactory: (
        db: SchedulerDbService,
        playerConfig: PlayerConfigService,
        manifestPublisher: ManifestPublisherService,
        redis: SchedulerRedisService,
        events: SchedulerEventsService,
        playerWebSocketGateway: PlayerWebSocketGatewayService,
      ) =>
        new SchedulerService(
          db,
          playerConfig,
          manifestPublisher,
          redis,
          events,
          playerWebSocketGateway,
          PLAYER_DEVICE_ID,
          PLAYER_CDN_URL,
          PLAYER_MANIFEST_BUCKET,
          process.env.AWS_REGION || 'ap-south-1',
        ),
      inject: [
        SchedulerDbService,
        PlayerConfigService,
        ManifestPublisherService,
        SchedulerRedisService,
        SchedulerEventsService,
        PlayerWebSocketGatewayService,
      ],
    },
    {
      provide: PlayerWebSocketGatewayService,
      useFactory: () =>
        new PlayerWebSocketGatewayService(
          Number.parseInt(process.env.PLAYER_WS_PORT || '3031', 10),
          process.env.PLAYER_WS_PATH || '/ws/player',
          process.env.PLAYER_WS_TOKEN || '',
          Number.parseInt(process.env.PLAYER_WS_HEARTBEAT_MS || '30000', 10),
          process.env.PLAYER_WS_ENABLED === 'true',
        ),
    },
    {
      provide: SchedulerQueueService,
      useFactory: (scheduler: SchedulerService) =>
        new SchedulerQueueService(
          scheduler,
          process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672',
          process.env.RABBITMQ_SCHEDULER_EVALUATE_QUEUE ||
            'scheduler.evaluate.now',
          process.env.RABBITMQ_SCHEDULER_RETRY_QUEUE ||
            'scheduler.evaluate.retry',
          process.env.RABBITMQ_SCHEDULER_DLQ ||
            'scheduler.evaluate.dead_letter',
          Number.parseInt(process.env.RABBITMQ_SCHEDULER_PREFETCH || '5', 10),
          Number.parseInt(process.env.RABBITMQ_SCHEDULER_MAX_RETRIES || '3', 10),
          Number.parseInt(process.env.RABBITMQ_SCHEDULER_RETRY_DELAY_MS || '10000', 10),
          Number.parseInt(process.env.RABBITMQ_SCHEDULER_METRICS_INTERVAL_MS || '30000', 10),
          process.env.RABBITMQ_ENABLED !== 'false',
        ),
      inject: [SchedulerService],
    },
    {
      provide: SchedulerEventConsumerService,
      useFactory: () =>
        new SchedulerEventConsumerService(
          REDPANDA_BROKERS,
          process.env.REDPANDA_CLIENT_ID || 'cms-worker-scheduler',
          process.env.REDPANDA_SCHEDULER_DEBUG_CONSUMER_GROUP ||
            'cms-worker-scheduler-debug',
          [
            process.env.REDPANDA_SCHEDULER_EVALUATION_TOPIC ||
              'scheduler.evaluation.completed',
            process.env.REDPANDA_PLAYER_MANIFEST_PUBLISHED_TOPIC ||
              'player.manifest.published',
            process.env.REDPANDA_PLAYER_UPDATE_FAILED_TOPIC ||
              'player.update.failed',
          ],
          process.env.REDPANDA_DEBUG_CONSUMER_ENABLED === 'true',
        ),
    },
    SchedulerProcessor,
  ],
  exports: [
    SchedulerService,
    SchedulerQueueService,
    SchedulerEventConsumerService,
    PlayerWebSocketGatewayService,
  ],
})
export class SchedulerModule {}
