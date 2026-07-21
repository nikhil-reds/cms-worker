import 'dotenv/config';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateConfig } from './config/config';
import { MediaSyncModule } from './workers/media-sync/media-sync.module';
import { PlaylistRenderModule } from './workers/playlist-render/playlist-render.module';
import { NotificationModule } from './workers/notification/notification.module';
import { AnalyticsModule } from './workers/analytics/analytics.module';
import { SensorModule } from './workers/sensor/sensor.module';
import { SchedulerModule } from './worker-schedule/scheduler.module';

/**
 * Role-based worker loading.
 *
 * WORKER_ROLE=all          → every worker in one process (dev / small deployments)
 * WORKER_ROLE=media-sync   → only the media sync worker
 * WORKER_ROLE=playlist-render → only the playlist render worker
 * WORKER_ROLE=notification → only the notification worker
 * WORKER_ROLE=analytics    → only the analytics worker
 * WORKER_ROLE=sensor       → only the sensor worker
 * WORKER_ROLE=scheduler    → only the scheduler worker
 *
 * At scale, deploy separate replicas per role.
 */
const WORKER_MODULES: Record<string, any> = {
  'media-sync': MediaSyncModule,
  'playlist-render': PlaylistRenderModule,
  notification: NotificationModule,
  analytics: AnalyticsModule,
  sensor: SensorModule,
  scheduler: SchedulerModule,
};

function resolveWorkerModules(): any[] {
  const role = process.env.WORKER_ROLE || 'media-sync';

  if (role === 'all') {
    return Object.values(WORKER_MODULES);
  }

  const module = WORKER_MODULES[role];
  if (!module) {
    throw new Error(
      `Unknown WORKER_ROLE "${role}". Valid roles: all, ${Object.keys(WORKER_MODULES).join(', ')}`,
    );
  }

  return [module];
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateConfig,
      envFilePath: ['.env.local', '.env'],
    }),
    ...resolveWorkerModules(),
  ],
})
export class AppModule {}
