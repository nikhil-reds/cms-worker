export type SensorTriggerType = 'motion' | 'proximity' | 'temperature' | 'button' | 'nfc' | 'custom';

export interface SensorEvent {
  id: string;
  tenantId: string;
  deviceId: string;
  sensorId: string;
  type: SensorTriggerType;
  value: number | string | boolean;
  payload?: Record<string, unknown>;
  occurredAt: Date;
}

export interface SensorRule {
  id: string;
  tenantId: string;
  sensorId: string;
  condition: string; // e.g. "value > 30", "type == motion"
  action: 'play_media' | 'switch_playlist' | 'notify' | 'webhook';
  actionPayload: Record<string, unknown>;
  enabled: boolean;
}

export interface SensorWorkerConfig {
  pollIntervalMs: number;
}
