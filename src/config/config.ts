import { z } from 'zod';

const EnvSchema = z.object({
  // Node environment
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Worker configuration
  WORKER_ROLE: z
    .enum(['all', 'media-sync', 'playlist-render', 'notification', 'analytics', 'sensor', 'scheduler'])
    .default('media-sync'),

  // Database - Neon PostgreSQL
  DATABASE_URL: z.string().url().describe('Neon PostgreSQL connection URL'),

  // AWS Configuration
  AWS_REGION: z.string().default('ap-south-1'),
  AWS_ACCESS_KEY_ID: z.string(),
  AWS_SECRET_ACCESS_KEY: z.string(),
  S3_BUCKET: z.string().optional().describe('S3 bucket for media storage (alias of AWS_BUCKET_MEDIA)'),
  AWS_BUCKET_MEDIA: z.string().optional().describe('S3 bucket for media storage'),

  // Media Sync Worker Configuration
  PLAYER_MEDIA_ROOT_PATH: z.string().default('/tmp/Player/media').describe('Root path for Player media folder'),
  MEDIA_SYNC_STRATEGY: z.enum(['polling', 'listen']).default('polling').describe('Database listening strategy'),
  MEDIA_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(30000).describe('Polling interval in milliseconds'),
  MEDIA_SYNC_CONCURRENCY: z.coerce.number().int().positive().default(5).describe('Number of concurrent downloads'),
  MEDIA_ENABLE_CHECKSUM_VALIDATION: z.coerce.boolean().default(true),
  MEDIA_MAX_DISK_USAGE_PERCENT: z.coerce.number().int().min(1).max(100).default(80),
  MEDIA_CLEANUP_ORPHANED_FILES: z.coerce.boolean().default(false),

  // Playlist Render Worker Configuration
  AWS_BUCKET_PLAYLIST: z.string().default('redsxp-playlist').describe('S3 bucket holding playlists/{id}.json written by the CMS'),
  AWS_BUCKET_MEDIA_PROCESSED: z.string().default('redsxp-media-processed').describe('S3 bucket where rendered playlist MP4s are uploaded'),
  AWS_BUCKET_PROCESSED: z.string().optional().describe('Legacy alias for AWS_BUCKET_MEDIA_PROCESSED'),
  PLAYLIST_RENDER_INTERVAL_MS: z.coerce.number().int().positive().default(30000).describe('Polling interval in milliseconds'),
  PLAYLIST_RENDER_RESOLUTION: z.string().regex(/^\d+x\d+$/).default('1920x1080').describe('Output resolution of rendered playlist videos'),
  PLAYLIST_RENDER_FPS: z.coerce.number().int().positive().default(30),
  PLAYLIST_RENDER_MODE: z.enum(['append', 'exclusive']).default('append').describe('append: add to player playlist; exclusive: replace it'),
  PLAYLIST_RENDER_SHORT_VIDEO: z.enum(['natural', 'loop']).default('natural').describe('Videos shorter than their item duration: play once or loop to fill'),
  PLAYLIST_RENDER_SCRATCH_DIR: z.string().default('/tmp/cms-worker/renders'),
  FFMPEG_PATH: z.string().optional().describe('Override for the bundled ffmpeg binary'),
  FFPROBE_PATH: z.string().optional().describe('Override for the bundled ffprobe binary'),

  // Scheduler realtime infrastructure
  REDIS_ENABLED: z.coerce.boolean().default(true),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  RABBITMQ_ENABLED: z.coerce.boolean().default(true),
  RABBITMQ_URL: z.string().default('amqp://guest:guest@localhost:5672'),
  RABBITMQ_SCHEDULER_EVALUATE_QUEUE: z.string().default('scheduler.evaluate.now'),
  RABBITMQ_SCHEDULER_RETRY_QUEUE: z.string().default('scheduler.evaluate.retry'),
  RABBITMQ_SCHEDULER_DLQ: z.string().default('scheduler.evaluate.dead_letter'),
  RABBITMQ_SCHEDULER_PREFETCH: z.coerce.number().int().positive().default(5),
  RABBITMQ_SCHEDULER_MAX_RETRIES: z.coerce.number().int().min(0).default(3),
  RABBITMQ_SCHEDULER_RETRY_DELAY_MS: z.coerce.number().int().positive().default(10000),
  RABBITMQ_SCHEDULER_METRICS_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  REDPANDA_ENABLED: z.coerce.boolean().default(true),
  REDPANDA_BROKERS: z.string().default('localhost:29092'),
  REDPANDA_CLIENT_ID: z.string().default('cms-worker-scheduler'),
  REDPANDA_SCHEDULER_EVALUATION_TOPIC: z
    .string()
    .default('scheduler.evaluation.completed'),
  REDPANDA_PLAYER_MANIFEST_PUBLISHED_TOPIC: z
    .string()
    .default('player.manifest.published'),
  REDPANDA_PLAYER_UPDATE_FAILED_TOPIC: z.string().default('player.update.failed'),
  REDPANDA_DEBUG_CONSUMER_ENABLED: z.coerce.boolean().default(false),
  REDPANDA_SCHEDULER_DEBUG_CONSUMER_GROUP: z
    .string()
    .default('cms-worker-scheduler-debug'),
  PLAYER_WS_ENABLED: z.coerce.boolean().default(false),
  PLAYER_WS_PORT: z.coerce.number().int().positive().default(3001),
  PLAYER_WS_PATH: z.string().default('/ws/player'),
  PLAYER_WS_TOKEN: z.string().default(''),
  PLAYER_WS_HEARTBEAT_MS: z.coerce.number().int().positive().default(30000),

  // Logging
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Environment = z.infer<typeof EnvSchema>;

export function validateConfig(config: Record<string, unknown>): Environment {
  try {
    return EnvSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const formatted = error.errors
        .map((err) => `${err.path.join('.')}: ${err.message}`)
        .join('\n');
      throw new Error(`Invalid environment configuration:\n${formatted}`);
    }
    throw error;
  }
}

export const config = {
  validate: validateConfig,
};
