import { Injectable, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { MediaSyncService } from './media-sync.service';

@Injectable()
export class MediaSyncProcessor implements OnApplicationBootstrap {
  private readonly logger = new Logger('MediaSyncProcessor');

  constructor(private mediaSyncService: MediaSyncService) {}

  async onApplicationBootstrap(): Promise<void> {
    this.logger.log('⚡ Bootstrapping Media Sync Worker');

    try {
      await this.mediaSyncService.start();
      this.logger.log('✓ Media Sync Worker started successfully');

      // Log stats every minute
      setInterval(async () => {
        try {
          const stats = await this.mediaSyncService.getStats();
          this.logger.log(
            `📊 Stats: Pending=${stats.database.pending} | Syncing=${stats.database.syncing} | ` +
            `Completed=${stats.database.completed} | Failed=${stats.database.failed} | ` +
            `DLQ=${stats.database.dlq} | Disk=${stats.disk.usagePercent}%`,
          );
        } catch (error) {
          this.logger.error('Error logging stats', error);
        }
      }, 60000); // Every minute
    } catch (error) {
      this.logger.error('Failed to start Media Sync Worker', error);
      process.exit(1);
    }
  }
}
