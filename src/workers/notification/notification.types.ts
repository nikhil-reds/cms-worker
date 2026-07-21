export type NotificationChannel = 'email' | 'webhook' | 'push' | 'internal';

export type NotificationSeverity = 'NONE' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface NotificationEvent {
  id: string;
  tenantId: string;
  type: string; // e.g. "device.offline", "media.sync_failed", "subscription.past_due"
  severity: NotificationSeverity;
  channel: NotificationChannel;
  payload: Record<string, unknown>;
  dedupeKey?: string; // prevents duplicate alerts for the same event
  createdAt: Date;
}

export interface NotificationDeliveryResult {
  eventId: string;
  channel: NotificationChannel;
  success: boolean;
  providerResponseId?: string;
  error?: string;
  deliveredAt: Date;
}

export interface NotificationWorkerConfig {
  pollIntervalMs: number;
  maxRetries: number;
}
