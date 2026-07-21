export type ScheduledJobType =
  | 'calendar.evaluate' // activate/deactivate calendars & playlists by time window
  | 'device.offline_check' // flag devices with stale heartbeats
  | 'analytics.rollup' // hourly/daily aggregate refresh
  | 'cleanup.old_media' // prune expired local media / logs
  | 'report.generate';

export interface ScheduledJob {
  id: string;
  type: ScheduledJobType;
  tenantId?: string; // absent = platform-wide job
  cron: string; // e.g. "*/1 * * * *"
  payload?: Record<string, unknown>;
  enabled: boolean;
  lastRunAt?: Date;
  nextRunAt?: Date;
}

export interface JobRunResult {
  jobId: string;
  type: ScheduledJobType;
  success: boolean;
  durationMs: number;
  error?: string;
}

export interface SchedulerWorkerConfig {
  tickIntervalMs: number; // how often the scheduler wakes up
}
