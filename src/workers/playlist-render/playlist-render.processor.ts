import { Injectable, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { PlaylistRenderService } from './playlist-render.service';

@Injectable()
export class PlaylistRenderProcessor implements OnApplicationBootstrap {
  private readonly logger = new Logger('PlaylistRenderProcessor');

  constructor(private playlistRenderService: PlaylistRenderService) {}

  async onApplicationBootstrap(): Promise<void> {
    this.logger.log('⚡ Bootstrapping Playlist Render Worker');

    try {
      await this.playlistRenderService.start();
      this.logger.log('✓ Playlist Render Worker started successfully');

      // Log stats every minute
      setInterval(async () => {
        try {
          const stats = await this.playlistRenderService.getStats();
          this.logger.log(
            `📊 Stats: Pending=${stats.pending} | Rendering=${stats.rendering} | ` +
              `Completed=${stats.completed} | Failed=${stats.failed} | DLQ=${stats.dlq}`,
          );
        } catch (error) {
          this.logger.error('Error logging stats', error);
        }
      }, 60000);
    } catch (error) {
      this.logger.error('Failed to start Playlist Render Worker', error);
      process.exit(1);
    }
  }
}
