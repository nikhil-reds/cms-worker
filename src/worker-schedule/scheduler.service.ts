import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { createLogger } from '../common/logger';
import { SchedulerDbService } from './scheduler-db.service';
import { PlayerConfigService } from '../workers/media-sync/player-config.service';
import { ManifestPublisherService } from './manifest-publisher.service';
import type { ScheduledJob, JobRunResult } from './scheduler.types';

const logger = createLogger('SchedulerService');

/**
 * Scheduler Worker — evaluates time-based calendar rules every minute
 * and points the player at the active scheduled playlist.
 *
 * Future responsibilities (not yet implemented):
 *  - Detect offline devices from stale heartbeats → notify
 *  - Run periodic maintenance: analytics rollups, cleanup, report generation
 */
@Injectable()
export class SchedulerService implements OnApplicationShutdown {
  private tickInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastActivePlaylistId: string | null = null;

  constructor(
    private db: SchedulerDbService,
    private playerConfig: PlayerConfigService,
    private manifestPublisher: ManifestPublisherService,
    private deviceId: string,
    private cdnBaseUrl: string = '',
    private processedBucket: string = '',
    private awsRegion: string = 'ap-south-1',
  ) {}

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    await this.db.initialize();
    logger.info('Scheduler worker started');

    // Evaluate calendars every minute
    this.tick().catch((error) =>
      logger.error('Initial scheduler tick error: %s', error?.message ?? error),
    );

    this.tickInterval = setInterval(() => {
      this.tick().catch((error) =>
        logger.error('Scheduler tick error: %s', error?.message ?? error),
      );
    }, 60000);
  }

  private async tick(): Promise<void> {
    try {
      if (this.manifestPublisher.enabled) {
        await this.publishScheduleManifest();
        return;
      }

      const active = await this.db.getActiveCalendar();

      if (!active) {
        // No schedule is active right now — fall back to empty playlist
        // (or the default state the player should have when no calendar applies)
        if (this.lastActivePlaylistId) {
          logger.info('No active calendar now, clearing scheduled playlist');
          await this.publishOrApplyPlaylist([]);
          this.lastActivePlaylistId = null;
        }
        return;
      }

      // Only update the player if the active calendar changed
      if (this.lastActivePlaylistId === active.playlistId) {
        return; // Already playing this one
      }

      logger.info(
        `Active calendar: "${active.name}" (priority ${active.priority}), ` +
          `switching to playlist ${active.playlistId}`,
      );

      // Fetch the rendered MP4 for this playlist
      const rendered = await this.db.getPlaylistRenderOutput(active.playlistId);

      if (!rendered) {
        logger.warn(
          `Calendar "${active.name}" points to playlist ${active.playlistId}, ` +
            `but no completed render found — skipping`,
        );
        return;
      }

      // Publish/apply a single-item playlist for the active rendered MP4.
      await this.publishOrApplyPlaylist([
        {
          id: active.playlistId,
          type: 'video',
          src: rendered.localSrc,
          url: this.toPublicMediaUrl(rendered.s3Url),
          loop: true,
          muted: false,
        },
      ]);

      this.lastActivePlaylistId = active.playlistId;
      logger.info(
        `✓ Player now playing "${active.name}" → ${rendered.s3Url}`,
      );
    } catch (error) {
      logger.error('Tick failed', error);
    }
  }

  private async publishScheduleManifest(): Promise<void> {
    const schedules = await this.db.getPublishedSchedules();
    const playlists = schedules.map((schedule) => ({
      id: schedule.playlistId,
      items: [
        {
          id: schedule.playlistId,
          type: 'video' as const,
          src: schedule.localSrc,
          url: this.toPublicMediaUrl(schedule.s3Url),
          loop: true,
          muted: false,
        },
      ],
    }));

    const revision = new Date().toISOString();
    const manifestUrl = await this.manifestPublisher.publish({
      schemaVersion: 1,
      deviceId: this.deviceId,
      revision,
      playlist: this.pickActivePlaylistFromSchedules(schedules),
      playlists,
      schedules: schedules.map((schedule) => ({
        id: schedule.id,
        name: schedule.name,
        playlistId: schedule.playlistId,
        priority: schedule.priority,
        startAt: schedule.startAt.toISOString(),
        endAt: schedule.endAt.toISOString(),
        daysOfWeek: schedule.daysOfWeek,
      })),
    });

    logger.info(
      `Published ${schedules.length} schedule(s) for player pull sync: ${manifestUrl}`,
    );
  }

  private pickActivePlaylistFromSchedules(
    schedules: Awaited<ReturnType<SchedulerDbService['getPublishedSchedules']>>,
  ) {
    const now = new Date();
    const active = schedules.find((schedule) => {
      const start = schedule.startAt.getTime();
      const end = schedule.endAt.getTime();
      return (
        now.getTime() >= start &&
        now.getTime() < end &&
        this.matchesDayOfWeek(schedule.daysOfWeek, now)
      );
    });

    if (!active) return [];

    return [
      {
        id: active.playlistId,
        type: 'video' as const,
        src: active.localSrc,
        url: this.toPublicMediaUrl(active.s3Url),
        loop: true,
        muted: false,
      },
    ];
  }

  private async publishOrApplyPlaylist(
    playlist: Array<{
      id: string;
      type: 'video' | 'image' | 'audio';
      src: string;
      url?: string;
      loop?: boolean;
      muted?: boolean;
      durationMs?: number;
    }>,
  ): Promise<void> {
    if (this.manifestPublisher.enabled) {
      const revision = new Date().toISOString();
      const manifestUrl = await this.manifestPublisher.publish({
        schemaVersion: 1,
        deviceId: this.deviceId,
        revision,
        playlist: playlist.map((item) => {
          if (!item.url) {
            throw new Error(`Manifest item ${item.id} is missing a download URL`);
          }
          return {
            id: item.id,
            type: item.type,
            src: item.src,
            url: item.url,
            loop: item.loop,
            muted: item.muted,
            durationMs: item.durationMs,
          };
        }),
      });
      logger.info(`Player will pull manifest from ${manifestUrl}`);
      return;
    }

    await this.playerConfig.replacePlaylist(
      playlist.map(({ url, ...item }) => item),
    );
  }

  private toPublicMediaUrl(url: string): string {
    if (!this.cdnBaseUrl) return url;

    const cdnBase = this.cdnBaseUrl.replace(/\/$/, '');
    const s3Bases = [
      `https://${this.processedBucket}.s3.${this.awsRegion}.amazonaws.com`,
      `https://${this.processedBucket}.s3.amazonaws.com`,
    ];

    for (const s3Base of s3Bases) {
      if (url.startsWith(s3Base)) {
        return `${cdnBase}${url.slice(s3Base.length)}`;
      }
    }

    return url;
  }

  private matchesDayOfWeek(daysOfWeek: number[], date: Date): boolean {
    const jsDay = date.getDay();
    const cmsSunday = jsDay === 0 ? 7 : jsDay;
    return daysOfWeek.includes(jsDay) || daysOfWeek.includes(cmsSunday);
  }

  async runJob(job: ScheduledJob): Promise<JobRunResult> {
    // TODO: dispatch by job.type
    logger.warn(`runJob() not implemented — skipping job ${job.id} (${job.type})`);
    return {
      jobId: job.id,
      type: job.type,
      success: false,
      durationMs: 0,
      error: 'not implemented',
    };
  }

  async stop(): Promise<void> {
    logger.info('Stopping Scheduler Worker');
    this.isRunning = false;
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    await this.db.close();
    logger.info('Scheduler worker stopped');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }
}
