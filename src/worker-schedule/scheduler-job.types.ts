export interface SchedulerEvaluateNowJob {
  jobId: string;
  type: 'scheduler.evaluate.now';
  reason?: string;
  requestedAt?: string;
  idempotencyKey?: string;
  tenantId?: string;
  playlistId?: string;
  scheduleId?: string;
  schedule?: {
    id: string;
    tenantId: string;
    playlistId: string;
    name: string;
    startTime: string;
    endTime: string;
    daysOfWeek: number[];
    priority: number;
    status: string;
    deviceIds?: string[];
    createdAt?: string;
    updatedAt?: string;
  };
}

export interface SchedulerEvaluationCompletedEvent {
  schemaVersion: 1;
  eventId: string;
  eventType: 'scheduler.evaluation.completed';
  jobId: string;
  reason?: string;
  tenantId?: string;
  playlistId?: string | null;
  scheduleId?: string;
  deviceId: string;
  success: boolean;
  changed: boolean;
  activePlaylistId: string | null;
  activeScheduleId: string | null;
  manifestPublished: boolean;
  playerApiUsed: boolean;
  source: 'realtime_job' | 'backup_tick';
  durationMs: number;
  error?: string;
  occurredAt: string;
}

export interface PlayerManifestPublishedEvent {
  schemaVersion: 1;
  eventId: string;
  eventType: 'player.manifest.published';
  deviceId: string;
  manifestUrl: string;
  manifestRevision: string;
  contentHash: string;
  playlistItemCount: number;
  source: 'realtime_job' | 'backup_tick';
  occurredAt: string;
}

export interface PlayerUpdateFailedEvent {
  schemaVersion: 1;
  eventId: string;
  eventType: 'player.update.failed';
  deviceId: string;
  playerApiUsed: boolean;
  manifestPublished: boolean;
  source: 'realtime_job' | 'backup_tick';
  error: string;
  occurredAt: string;
}
