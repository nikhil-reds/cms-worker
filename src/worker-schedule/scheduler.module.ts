import { Module } from '@nestjs/common';
import { join } from 'path';
import { SchedulerService } from './scheduler.service';
import { SchedulerProcessor } from './scheduler.processor';
import { SchedulerDbService } from './scheduler-db.service';
import { PlayerConfigService } from '../workers/media-sync/player-config.service';
import { ManifestPublisherService } from './manifest-publisher.service';

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
      provide: SchedulerService,
      useFactory: (
        db: SchedulerDbService,
        playerConfig: PlayerConfigService,
        manifestPublisher: ManifestPublisherService,
      ) =>
        new SchedulerService(
          db,
          playerConfig,
          manifestPublisher,
          PLAYER_DEVICE_ID,
          PLAYER_CDN_URL,
          PLAYER_MANIFEST_BUCKET,
          process.env.AWS_REGION || 'ap-south-1',
        ),
      inject: [SchedulerDbService, PlayerConfigService, ManifestPublisherService],
    },
    SchedulerProcessor,
  ],
  exports: [SchedulerService],
})
export class SchedulerModule {}
