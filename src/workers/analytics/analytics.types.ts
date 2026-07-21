export type AnalyticsEventType =
  | 'device.heartbeat'
  | 'proof_of_play'
  | 'media.downloaded'
  | 'playlist.applied'
  | 'device.error';

export interface AnalyticsEvent {
  id: string;
  tenantId: string;
  deviceId: string;
  type: AnalyticsEventType;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export interface IngestionBatchResult {
  received: number;
  inserted: number;
  duplicates: number;
  failed: number;
  durationMs: number;
}

export interface AnalyticsWorkerConfig {
  pollIntervalMs: number;
  batchSize: number; // rows per batch insert
}
