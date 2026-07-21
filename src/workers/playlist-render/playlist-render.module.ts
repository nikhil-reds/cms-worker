import { Module } from '@nestjs/common';
import { join } from 'path';
import { PlaylistRenderProcessor } from './playlist-render.processor';
import { PlaylistRenderService } from './playlist-render.service';
import { PlaylistDbService } from './playlist-db.service';
import { PlaylistS3Service } from './playlist-s3.service';
import { FfmpegRenderService } from './ffmpeg-render.service';
import { PlayerConfigService } from '../media-sync/player-config.service';
import { PlaylistRenderConfig } from './playlist-render.types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegStatic: string | null = require('ffmpeg-static');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffprobeStatic: { path: string } = require('ffprobe-static');

const PLAYER_ROOT =
  process.env.PLAYER_ROOT_PATH || '/Users/nikhil/Desktop/player';
const PLAYER_API_URL = (process.env.PLAYER_API_URL || '').replace(/\/$/, '');

function parseResolution(value: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) return { width: 1920, height: 1080 };
  return { width: parseInt(match[1]), height: parseInt(match[2]) };
}

@Module({
  providers: [
    {
      provide: 'PLAYLIST_RENDER_CONFIG',
      useFactory: (): PlaylistRenderConfig => ({
        playerRootPath: PLAYER_ROOT,
        playerMediaRootPath:
          process.env.PLAYER_MEDIA_ROOT_PATH ||
          (PLAYER_API_URL ? '/tmp/cms-worker/player-media' : join(PLAYER_ROOT, 'media')),
        mediaBucket:
          process.env.AWS_BUCKET_MEDIA ||
          process.env.S3_BUCKET ||
          process.env.AWS_BUCKET ||
          '',
        playlistBucket: process.env.AWS_BUCKET_PLAYLIST || 'redsxp-playlist',
        processedBucket:
          process.env.AWS_BUCKET_MEDIA_PROCESSED || 'redsxp-media-processed',
        pollIntervalMs: parseInt(
          process.env.PLAYLIST_RENDER_INTERVAL_MS || '30000',
        ),
        resolution: parseResolution(
          process.env.PLAYLIST_RENDER_RESOLUTION || '1920x1080',
        ),
        fps: parseInt(process.env.PLAYLIST_RENDER_FPS || '30'),
        playerConfigMode: (process.env.PLAYLIST_RENDER_MODE as any) || 'append',
        shortVideoBehavior:
          (process.env.PLAYLIST_RENDER_SHORT_VIDEO as any) || 'natural',
        scratchDir:
          process.env.PLAYLIST_RENDER_SCRATCH_DIR || '/tmp/cms-worker/renders',
        ffmpegPath: process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg',
        ffprobePath:
          process.env.FFPROBE_PATH || ffprobeStatic.path || 'ffprobe',
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
      provide: FfmpegRenderService,
      useFactory: (config: PlaylistRenderConfig) =>
        new FfmpegRenderService(config),
      inject: ['PLAYLIST_RENDER_CONFIG'],
    },
    {
      provide: PlaylistRenderService,
      useFactory: (
        db: PlaylistDbService,
        s3: PlaylistS3Service,
        renderer: FfmpegRenderService,
        playerConfig: PlayerConfigService,
        config: PlaylistRenderConfig,
      ) => new PlaylistRenderService(db, s3, renderer, playerConfig, config),
      inject: [
        PlaylistDbService,
        PlaylistS3Service,
        FfmpegRenderService,
        PlayerConfigService,
        'PLAYLIST_RENDER_CONFIG',
      ],
    },
    PlaylistRenderProcessor,
  ],
  exports: [PlaylistRenderService],
})
export class PlaylistRenderModule {}
