import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { createHash } from 'crypto';
import { createLogger } from '../common/logger';
import { SchedulerDbService } from './scheduler-db.service';
import { PlayerConfigService } from '../workers/media-sync/player-config.service';
import { ManifestPublisherService } from './manifest-publisher.service';
import { SchedulerRedisService } from './scheduler-redis.service';
import { SchedulerEventsService } from './scheduler-events.service';
import { PlayerWebSocketGatewayService } from './player-websocket-gateway.service';
import type { ScheduledJob, JobRunResult } from './scheduler.types';
import type { SchedulerEvaluateNowJob } from './scheduler-job.types';
import type { PlayerManifestItem } from './manifest-publisher.service';

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
    private redis: SchedulerRedisService,
    private events: SchedulerEventsService,
    private playerWebSocketGateway: PlayerWebSocketGatewayService,
    // Only used by the legacy single-player path (local dev without an S3
    // manifest bucket). Manifest publishing resolves devices from the database.
    private deviceId: string = '',
    private cdnBaseUrl: string = '',
    private processedBucket: string = '',
    private awsRegion: string = 'ap-south-1',
  ) {}

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    await this.db.initialize();
    await this.redis.initialize();
    await this.events.initialize();
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
        await this.publishScheduleManifest('backup_tick');
        return;
      }

      await this.evaluateActiveSchedule('backup_tick');
    } catch (error) {
      logger.error('Tick failed', error);
    }
  }

  async evaluateNow(job: SchedulerEvaluateNowJob): Promise<void> {
    const startedAt = Date.now();
    const idempotencyKey =
      job.idempotencyKey || `scheduler.evaluate.now:${job.scheduleId || job.jobId}`;
    const lockKey = job.scheduleId || job.playlistId || job.tenantId || 'global';

    if (await this.redis.isProcessed(idempotencyKey)) {
      logger.info(`Skipping duplicate scheduler job ${job.jobId}`);
      return;
    }

    const lockToken = await this.redis.acquireLock(`evaluate:${lockKey}`, 30000);
    if (!lockToken) {
      throw new Error(`Could not acquire scheduler lock for ${lockKey}`);
    }

    let success = false;
    let changed = false;
    let activePlaylistId: string | null = null;
    let activeScheduleId: string | null = null;
    let errorMessage: string | undefined;

    try {
      const result = this.manifestPublisher.enabled
        ? await this.publishScheduleManifest('realtime_job')
        : await this.evaluateActiveSchedule('realtime_job');
      success = true;
      changed = result.changed;
      activePlaylistId = result.activePlaylistId;
      activeScheduleId = result.activeScheduleId;

      await this.redis.setActiveState(lockKey, {
        activePlaylistId,
        activeScheduleId,
        evaluatedAt: new Date().toISOString(),
        jobId: job.jobId,
      });
      await this.redis.markProcessed(idempotencyKey);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await this.redis.releaseLock(`evaluate:${lockKey}`, lockToken);

      await this.events
        .emitEvaluationCompleted({
          schemaVersion: 1,
          eventId: crypto.randomUUID(),
          eventType: 'scheduler.evaluation.completed',
          jobId: job.jobId,
          reason: job.reason,
          tenantId: job.tenantId,
          playlistId: job.playlistId || activePlaylistId,
          scheduleId: job.scheduleId,
          deviceId: this.deviceId,
          success,
          changed,
          activePlaylistId,
          activeScheduleId,
          manifestPublished: this.manifestPublisher.enabled,
          playerApiUsed: this.playerConfig.isRemote,
          source: 'realtime_job',
          durationMs: Date.now() - startedAt,
          error: errorMessage,
          occurredAt: new Date().toISOString(),
        })
        .catch((error) => {
          logger.error('Could not emit scheduler.evaluation.completed', error);
        });
    }
  }

  private async evaluateActiveSchedule(source: 'realtime_job' | 'backup_tick'): Promise<{
    changed: boolean;
    activePlaylistId: string | null;
    activeScheduleId: string | null;
  }> {
    const active = await this.db.getActiveCalendar();

    if (!active) {
      if (this.lastActivePlaylistId) {
        logger.info(`source=${source} No active calendar now, clearing scheduled playlist`);
        await this.publishOrApplyPlaylist([], source);
        this.lastActivePlaylistId = null;
        return {
          changed: true,
          activePlaylistId: null,
          activeScheduleId: null,
        };
      }

      return {
        changed: false,
        activePlaylistId: null,
        activeScheduleId: null,
      };
    }

    if (this.lastActivePlaylistId === active.playlistId) {
      return {
        changed: false,
        activePlaylistId: active.playlistId,
        activeScheduleId: active.id,
      };
    }

    logger.info(
      `Active calendar: "${active.name}" (priority ${active.priority}), ` +
        `switching to playlist ${active.playlistId} source=${source}`,
    );

    const directItems = await this.db.getPlaylistPlaybackItems(active.playlistId);
    if (directItems.length === 0) {
      logger.warn(
        `Calendar "${active.name}" points to playlist ${active.playlistId}, ` +
          `but no playable READY media was found — skipping`,
      );
      return {
        changed: false,
        activePlaylistId: active.playlistId,
        activeScheduleId: active.id,
      };
    }

    await this.publishOrApplyPlaylist(directItems, source);

    this.lastActivePlaylistId = active.playlistId;
    logger.info(
      `✓ Player now playing native playlist "${active.name}" (${directItems.length} item(s)) source=${source}`,
    );

    return {
      changed: true,
      activePlaylistId: active.playlistId,
      activeScheduleId: active.id,
    };
  }

  /**
   * Publishes one manifest per installed screen. Each device only receives the
   * schedules that target it, so content assigned to Screen 01 never reaches
   * Screen 02.
   */
  private async publishScheduleManifest(source: 'realtime_job' | 'backup_tick'): Promise<{
    changed: boolean;
    activePlaylistId: string | null;
    activeScheduleId: string | null;
  }> {
    const devices = await this.db.getTargetDevices();

    if (devices.length === 0) {
      logger.warn(
        `source=${source} No installed players found; nothing to publish. ` +
          'Install a player from the CMS to create a screen.',
      );
      return { changed: false, activePlaylistId: null, activeScheduleId: null };
    }

    const untargeted = await this.db.getUntargetedActiveCalendars();
    if (untargeted.length > 0) {
      logger.warn(
        `source=${source} ${untargeted.length} active schedule(s) target no screen and will not play: ` +
          untargeted.map((calendar) => `"${calendar.name}"`).join(', '),
      );
    }

    let anyChanged = false;
    let firstActivePlaylistId: string | null = null;
    let firstActiveScheduleId: string | null = null;

    for (const device of devices) {
      try {
        const result = await this.publishScheduleManifestForDevice(device.id, source);
        if (result.changed) anyChanged = true;
        if (firstActivePlaylistId === null) firstActivePlaylistId = result.activePlaylistId;
        if (firstActiveScheduleId === null) firstActiveScheduleId = result.activeScheduleId;
      } catch (error) {
        // One bad screen must not stop the rest from being updated.
        logger.error(
          `source=${source} Failed to publish manifest for device ${device.id} (${device.name}): %s`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return {
      changed: anyChanged,
      activePlaylistId: firstActivePlaylistId,
      activeScheduleId: firstActiveScheduleId,
    };
  }

  private async publishScheduleManifestForDevice(
    deviceId: string,
    source: 'realtime_job' | 'backup_tick',
  ): Promise<{
    changed: boolean;
    activePlaylistId: string | null;
    activeScheduleId: string | null;
  }> {
    const schedules = await this.db.getPublishedSchedules(deviceId);
    const playlistIds = [...new Set(schedules.map((schedule) => schedule.playlistId))];
    const playlists = await Promise.all(playlistIds.map(async (playlistId) => {
      const playbackManifest = await this.db.getPlaylistPlaybackManifest(playlistId);
      const playlistVersion = this.playlistVersionFor(playbackManifest);
      await this.manifestPublisher.publishPlaylist({
        schemaVersion: 3,
        playlistId,
        playlistVersion,
        revision: playlistVersion,
        serverNow: new Date().toISOString(),
        canvas: playbackManifest.canvas,
        zones: playbackManifest.zones,
        items: playbackManifest.items,
      });

      return {
        id: playlistId,
        version: playlistVersion,
        canvas: playbackManifest.canvas,
        zones: playbackManifest.zones,
        items: playbackManifest.items,
      };
    }));

    const activeSchedule = this.pickActiveSchedule(schedules);
    const activePlaylist = activeSchedule
      ? playlists.find((candidate) => candidate.id === activeSchedule.playlistId)?.items ?? []
      : [];
    const activePlaylistVersion = activeSchedule
      ? playlists.find((candidate) => candidate.id === activeSchedule.playlistId)?.version
      : undefined;
    const scheduleEntries = schedules.map((schedule) => ({
      id: schedule.id,
      name: schedule.name,
      playlistId: schedule.playlistId,
      playlistVersion:
        playlists.find((candidate) => candidate.id === schedule.playlistId)?.version || 'missing',
      priority: schedule.priority,
      startAt: schedule.startAt.toISOString(),
      endAt: schedule.endAt.toISOString(),
      daysOfWeek: schedule.daysOfWeek,
    }));
    const manifestContent = {
      schemaVersion: 3 as const,
      deviceId: deviceId,
      serverNow: new Date().toISOString(),
      active:
        activeSchedule && activePlaylistVersion
          ? {
              playlistId: activeSchedule.playlistId,
              playlistVersion: activePlaylistVersion,
            }
          : null,
      schedules: scheduleEntries,
    };
    const contentHash = this.hashJson(manifestContent);
    const manifestState = await this.redis.getManifestState(deviceId);

    if (manifestState?.contentHash === contentHash) {
      logger.info(
        `source=${source} Manifest content unchanged for ${deviceId}, skipping publish`,
      );
      return {
        changed: false,
        activePlaylistId: activeSchedule?.playlistId || null,
        activeScheduleId: activeSchedule?.id || null,
      };
    }

    const revision = new Date().toISOString();
    const manifestUrl = await this.manifestPublisher.publish({
      ...manifestContent,
      revision,
    });

    await this.redis.setManifestState(deviceId, {
      contentHash,
      revision,
      manifestUrl,
    });
    await this.events.emitManifestPublished({
      schemaVersion: 1,
      eventId: crypto.randomUUID(),
      eventType: 'player.manifest.published',
      deviceId: deviceId,
      manifestUrl,
      manifestRevision: revision,
      contentHash,
      playlistItemCount: activePlaylist.length,
      source,
      occurredAt: new Date().toISOString(),
    });
    this.playerWebSocketGateway.notifyManifestUpdated({
      schemaVersion: 1,
      type: 'manifest.updated',
      eventId: crypto.randomUUID(),
      deviceId: deviceId,
      manifestUrl,
      manifestRevision: revision,
      contentHash,
      publishedAt: new Date().toISOString(),
    });

    logger.info(
      `source=${source} Published ${schedules.length} schedule(s) for player pull sync: ${manifestUrl}`,
    );

    return {
      changed: true,
      activePlaylistId: activeSchedule?.playlistId || null,
      activeScheduleId: activeSchedule?.id || null,
    };
  }

  private pickActiveSchedule(
    schedules: Awaited<ReturnType<SchedulerDbService['getPublishedSchedules']>>,
  ) {
    const now = new Date();
    return schedules.find((schedule) => {
      const start = schedule.startAt.getTime();
      const end = schedule.endAt.getTime();
      return (
        now.getTime() >= start &&
        now.getTime() < end &&
        this.matchesDayOfWeek(schedule.daysOfWeek, now)
      );
    });
  }

  private async publishOrApplyPlaylist(
    playlist: Array<{
      id: string;
      mediaId?: string;
      type: 'video' | 'image' | 'audio' | 'html';
      src: string;
      url?: string;
      sourceType?: 'upload' | 'external_url';
      loop?: boolean;
      muted?: boolean;
      fit?: 'cover' | 'contain' | 'fill' | 'none' | 'scale-down';
      position?: 'center' | 'top' | 'bottom' | 'left' | 'right';
      width?: number;
      height?: number;
      durationMs?: number;
      navigationPolicy?: 'same_origin' | 'allowlist' | 'allow_all';
      navigationAllowlist?: string[];
      reloadPolicy?: 'on_each_play' | 'once_per_playlist' | 'interval' | 'never';
      reloadIntervalMs?: number;
      loadTimeoutMs?: number;
    }>,
    source: 'realtime_job' | 'backup_tick',
  ): Promise<void> {
    const contentHash = this.hashJson(playlist);
    const revision = new Date().toISOString();

    try {
      if (this.manifestPublisher.enabled && this.deviceId) {
        const manifestState = await this.redis.getManifestState(this.deviceId);
        if (manifestState?.contentHash === contentHash) {
          logger.info(
            `source=${source} Manifest content unchanged for ${this.deviceId}, skipping publish`,
          );
          return;
        }

        const manifestPlaylist = playlist.map((item) => {
          const isExternalHtml = item.type === 'html' && (item.sourceType === 'external_url' || /^https?:\/\//i.test(item.src));
          if (!item.url && !isExternalHtml) {
            throw new Error(`Manifest item ${item.id} is missing a download URL`);
          }
          return {
            id: item.id,
            mediaId: item.mediaId,
            type: item.type,
            src: item.src,
            url: item.url ?? (isExternalHtml ? item.src : undefined),
            sourceType: item.sourceType,
            loop: item.loop,
            muted: item.muted,
            fit: item.fit,
            position: item.position,
            width: item.width,
            height: item.height,
            durationMs: item.durationMs,
            navigationPolicy: item.navigationPolicy,
            navigationAllowlist: item.navigationAllowlist,
            reloadPolicy: item.reloadPolicy,
            reloadIntervalMs: item.reloadIntervalMs,
            loadTimeoutMs: item.loadTimeoutMs,
          };
        });
        const playlistId = `direct-${this.deviceId}`;
        const playlistVersion = this.playlistVersionFor(manifestPlaylist);
        await this.manifestPublisher.publishPlaylist({
          schemaVersion: 3,
          playlistId,
          playlistVersion,
          revision: playlistVersion,
          serverNow: new Date().toISOString(),
          items: manifestPlaylist,
        });

        const manifestUrl = await this.manifestPublisher.publish({
          schemaVersion: 3,
          deviceId: this.deviceId,
          revision,
          serverNow: new Date().toISOString(),
          active: {
            playlistId,
            playlistVersion,
          },
          schedules: [],
        });

        await this.redis.setManifestState(this.deviceId, {
          contentHash,
          revision,
          manifestUrl,
        });
        await this.events.emitManifestPublished({
          schemaVersion: 1,
          eventId: crypto.randomUUID(),
          eventType: 'player.manifest.published',
          deviceId: this.deviceId,
          manifestUrl,
          manifestRevision: revision,
          contentHash,
          playlistItemCount: playlist.length,
          source,
          occurredAt: new Date().toISOString(),
        });
        this.playerWebSocketGateway.notifyManifestUpdated({
          schemaVersion: 1,
          type: 'manifest.updated',
          eventId: crypto.randomUUID(),
          deviceId: this.deviceId,
          manifestUrl,
          manifestRevision: revision,
          contentHash,
          publishedAt: new Date().toISOString(),
        });
        logger.info(`source=${source} Player will pull manifest from ${manifestUrl}`);
      return;
      }

      const playerRevision = await this.redis.getPlayerRevision(this.deviceId);
      if (playerRevision === contentHash) {
        logger.info(
          `source=${source} Player playlist unchanged for ${this.deviceId}, skipping update`,
        );
        return;
      }

      await this.playerConfig.replacePlaylist(
        playlist.map(({ url, ...item }) => item),
      );
      await this.redis.setPlayerRevision(this.deviceId, contentHash);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.events
        .emitPlayerUpdateFailed({
          schemaVersion: 1,
          eventId: crypto.randomUUID(),
          eventType: 'player.update.failed',
          deviceId: this.deviceId,
          playerApiUsed: this.playerConfig.isRemote,
          manifestPublished: this.manifestPublisher.enabled,
          source,
          error: message,
          occurredAt: new Date().toISOString(),
        })
        .catch((emitError) => {
          logger.error('Could not emit player.update.failed', emitError);
        });
      throw error;
    }
  }

  private hashJson(value: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(value))
      .digest('hex');
  }

  private playlistVersionFor(content: PlayerManifestItem[] | unknown): string {
    return this.hashJson(content).slice(0, 16);
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
    await this.events.close();
    await this.redis.close();
    await this.db.close();
    logger.info('Scheduler worker stopped');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }
}
