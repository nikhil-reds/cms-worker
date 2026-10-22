import { Module } from '@nestjs/common';
import { PlaylistRenderProcessor } from './playlist-render.processor';
import { PlaylistRenderService } from './playlist-render.service';
import { PlaylistDbService } from './playlist-db.service';
import { PlaylistS3Service } from './playlist-s3.service';
import { PlayerConfigService } from '../media-sync/player-config.service';
import { PlaylistRenderConfig } from './playlist-render.types';
import { SchedulerEvaluatePublisherService } from './scheduler-evaluate-publisher.service';
import { PlaylistRenderQueueService } from './playlist-render-queue.service';
import {
  defaultScratchDir,
  resolvePlayerMediaRootPath,
  resolvePlayerRootPath,
} from '../../config/paths';

const PLAYER_ROOT = resolvePlayerRootPath(process.env.PLAYER_ROOT_PATH);
const PLAYER_API_URL = (process.env.PLAYER_API_URL || '').replace(/\/$/, '');

@Module({
  providers: [
    {
      provide: 'PLAYLIST_RENDER_CONFIG',
      useFactory: (): PlaylistRenderConfig => ({
        playerRootPath: PLAYER_ROOT,
        playerMediaRootPath: resolvePlayerMediaRootPath(
          process.env.PLAYER_MEDIA_ROOT_PATH,
          PLAYER_ROOT,
          PLAYER_API_URL,
        ),
        mediaBucket:
          process.env.AWS_BUCKET_MEDIA ||
          process.env.S3_BUCKET ||
          process.env.AWS_BUCKET ||
          '',
        playlistBucket: process.env.AWS_BUCKET_PLAYLIST || 'redsxp-playlist',
        processedBucket:
          process.env.AWS_BUCKET_MEDIA_PROCESSED ||
          process.env.AWS_BUCKET_PROCESSED ||
          'redsxp-media-processed',
        pollIntervalMs: parseInt(
          process.env.PLAYLIST_RENDER_INTERVAL_MS || '30000',
        ),
        playerConfigMode: (process.env.PLAYLIST_RENDER_MODE as any) || 'append',
        scratchDir:
          process.env.PLAYLIST_RENDER_SCRATCH_DIR || defaultScratchDir(),
      }),
    },
    {
      provide: PlaylistDbService,
      useFactory: () => new PlaylistDbService(process.env.DATABASE_URL || ''),
    },
    {
      provide: PlaylistS3Service,
      useFactory: () =>
        new PlaylistS3Service(
          process.env.AWS_REGION || 'ap-south-1',
          process.env.AWS_ACCESS_KEY_ID || '',
          process.env.AWS_SECRET_ACCESS_KEY || '',
          process.env.PLAYER_CDN_URL ||
            process.env.NEXT_PUBLIC_CDN_URL ||
            process.env.CLOUDFRONT_URL ||
            '',
        ),
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
      provide: SchedulerEvaluatePublisherService,
      useFactory: () =>
        new SchedulerEvaluatePublisherService(
          process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672',
          process.env.RABBITMQ_SCHEDULER_EVALUATE_QUEUE ||
            'scheduler.evaluate.now',
          process.env.RABBITMQ_ENABLED === 'true',
        ),
    },
    {
      provide: PlaylistRenderService,
      useFactory: (
        db: PlaylistDbService,
        s3: PlaylistS3Service,
        playerConfig: PlayerConfigService,
        schedulerPublisher: SchedulerEvaluatePublisherService,
        config: PlaylistRenderConfig,
      ) =>
        new PlaylistRenderService(
          db,
          s3,
          playerConfig,
          schedulerPublisher,
          config,
        ),
      inject: [
        PlaylistDbService,
        PlaylistS3Service,
        PlayerConfigService,
        SchedulerEvaluatePublisherService,
        'PLAYLIST_RENDER_CONFIG',
      ],
    },
    {
      provide: PlaylistRenderQueueService,
      useFactory: (renderer: PlaylistRenderService) =>
        new PlaylistRenderQueueService(
          renderer,
          process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672',
          process.env.RABBITMQ_PLAYLIST_RENDER_QUEUE ||
            'playlist.render.requested',
          process.env.RABBITMQ_PLAYLIST_RENDER_RETRY_QUEUE ||
            'playlist.render.retry',
          process.env.RABBITMQ_PLAYLIST_RENDER_DLQ ||
            'playlist.render.dead_letter',
          parseInt(process.env.RABBITMQ_PLAYLIST_RENDER_RETRY_DELAY_MS || '10000'),
          parseInt(process.env.RABBITMQ_PLAYLIST_RENDER_MAX_RETRIES || '3'),
          process.env.RABBITMQ_ENABLED === 'true',
        ),
      inject: [PlaylistRenderService],
    },
    PlaylistRenderProcessor,
  ],
  exports: [PlaylistRenderService],
})
export class PlaylistRenderModule {}
