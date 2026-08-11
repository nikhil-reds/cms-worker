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
    private deviceId: string,
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

    const containsHtml = await this.db.playlistContainsHtml(active.playlistId);
    const directItems = containsHtml ? await this.db.getPlaylistPlaybackItems(active.playlistId) : [];

    if (containsHtml && directItems.length > 0) {
      await this.publishOrApplyPlaylist(directItems, source);

      this.lastActivePlaylistId = active.playlistId;
      logger.info(`✓ Player now playing HTML-capable playlist "${active.name}" source=${source}`);

      return {
        changed: true,
        activePlaylistId: active.playlistId,
        activeScheduleId: active.id,
      };
    }

    const rendered = await this.db.getPlaylistRenderOutput(active.playlistId);

    if (!rendered) {
      logger.warn(
        `Calendar "${active.name}" points to playlist ${active.playlistId}, ` +
          `but no completed render found — skipping`,
      );
      return {
        changed: false,
        activePlaylistId: active.playlistId,
        activeScheduleId: active.id,
      };
    }

    await this.publishOrApplyPlaylist([
      {
        id: active.playlistId,
        type: 'video',
        src: rendered.localSrc,
        url: this.toPublicMediaUrl(rendered.s3Url),
        loop: true,
        muted: false,
        fit: 'scale-down' as const,
        position: 'center' as const,
        width: rendered.displayWidth,
        height: rendered.displayHeight,
      },
    ], source);

    this.lastActivePlaylistId = active.playlistId;
    logger.info(`✓ Player now playing "${active.name}" → ${rendered.s3Url} source=${source}`);

    return {
      changed: true,
      activePlaylistId: active.playlistId,
      activeScheduleId: active.id,
    };
  }

  private async publishScheduleManifest(source: 'realtime_job' | 'backup_tick'): Promise<{
    changed: boolean;
    activePlaylistId: string | null;
    activeScheduleId: string | null;
  }> {
    const schedules = await this.db.getPublishedSchedules();
    const playlists = await Promise.all(schedules.map(async (schedule) => {
      if (schedule.hasHtml) {
        return {
          id: schedule.playlistId,
          items: await this.db.getPlaylistPlaybackItems(schedule.playlistId),
        };
      }

      if (!schedule.localSrc || !schedule.s3Url) {
        return { id: schedule.playlistId, items: [] };
      }

      return {
        id: schedule.playlistId,
        items: [
          {
            id: schedule.playlistId,
            type: 'video' as const,
            src: schedule.localSrc,
            url: this.toPublicMediaUrl(schedule.s3Url),
            loop: true,
            muted: false,
            fit: 'scale-down' as const,
            position: 'center' as const,
            width: schedule.displayWidth,
            height: schedule.displayHeight,
          },
        ],
      };
    }));

    const playlist = this.pickActivePlaylistFromSchedules(schedules, playlists);
    const scheduleEntries = schedules.map((schedule) => ({
      id: schedule.id,
      name: schedule.name,
      playlistId: schedule.playlistId,
      priority: schedule.priority,
      startAt: schedule.startAt.toISOString(),
      endAt: schedule.endAt.toISOString(),
      daysOfWeek: schedule.daysOfWeek,
    }));
    const manifestContent = {
      schemaVersion: 1 as const,
      deviceId: this.deviceId,
      serverNow: new Date().toISOString(),
      playlist,
      playlists,
      schedules: scheduleEntries,
    };
    const contentHash = this.hashJson(manifestContent);
    const manifestState = await this.redis.getManifestState(this.deviceId);

    if (manifestState?.contentHash === contentHash) {
      logger.info(
        `source=${source} Manifest content unchanged for ${this.deviceId}, skipping publish`,
      );
      return {
        changed: false,
        activePlaylistId: playlist[0]?.id || null,
        activeScheduleId: scheduleEntries.find((schedule) => schedule.playlistId === playlist[0]?.id)?.id || null,
      };
    }

    const revision = new Date().toISOString();
    const manifestUrl = await this.manifestPublisher.publish({
      ...manifestContent,
      revision,
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

    logger.info(
      `source=${source} Published ${schedules.length} schedule(s) for player pull sync: ${manifestUrl}`,
    );

    return {
      changed: true,
      activePlaylistId: playlist[0]?.id || null,
      activeScheduleId: scheduleEntries.find((schedule) => schedule.playlistId === playlist[0]?.id)?.id || null,
    };
  }

  private pickActivePlaylistFromSchedules(
    schedules: Awaited<ReturnType<SchedulerDbService['getPublishedSchedules']>>,
    playlists: Array<{ id: string; items: Array<{
      id: string;
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
    }> }>,
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

    if (active.hasHtml) {
      return playlists.find((playlist) => playlist.id === active.playlistId)?.items ?? [];
    }

    return [
      {
        id: active.playlistId,
        type: 'video' as const,
        src: active.localSrc || '',
        url: active.s3Url ? this.toPublicMediaUrl(active.s3Url) : '',
        loop: true,
        muted: false,
        fit: 'scale-down' as const,
        position: 'center' as const,
        width: active.displayWidth,
        height: active.displayHeight,
      },
    ];
  }

  private async publishOrApplyPlaylist(
    playlist: Array<{
      id: string;
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
      if (this.manifestPublisher.enabled) {
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

        const manifestUrl = await this.manifestPublisher.publish({
        schemaVersion: 1,
        deviceId: this.deviceId,
        revision,
        playlist: manifestPlaylist,
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
    await this.events.close();
    await this.redis.close();
    await this.db.close();
    logger.info('Scheduler worker stopped');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }
}
