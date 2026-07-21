import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Kafka, logLevel, type Producer } from 'kafkajs';
import { createLogger } from '../common/logger';
import type {
  PlayerManifestPublishedEvent,
  PlayerUpdateFailedEvent,
  SchedulerEvaluationCompletedEvent,
} from './scheduler-job.types';

const logger = createLogger('SchedulerEventsService');

@Injectable()
export class SchedulerEventsService implements OnApplicationShutdown {
  private producer: Producer | null = null;

  constructor(
    private readonly brokers: string[],
    private readonly clientId: string,
    private readonly evaluationTopic: string,
    private readonly manifestPublishedTopic: string,
    private readonly playerUpdateFailedTopic: string,
    private readonly enabled = true,
  ) {}

  async initialize(): Promise<void> {
    if (!this.enabled || this.brokers.length === 0) return;

    const kafka = new Kafka({
      clientId: this.clientId,
      brokers: this.brokers,
      connectionTimeout: 1000,
      requestTimeout: 2000,
      retry: { retries: 1, initialRetryTime: 100 },
      logLevel: logLevel.NOTHING,
    });

    this.producer = kafka.producer();
    await this.producer.connect();
    logger.info(`Redpanda producer connected (${this.brokers.join(', ')})`);
  }

  async emitEvaluationCompleted(event: SchedulerEvaluationCompletedEvent): Promise<void> {
    await this.emit(this.evaluationTopic, event.playlistId || event.scheduleId || event.jobId, event);
  }

  async emitManifestPublished(event: PlayerManifestPublishedEvent): Promise<void> {
    await this.emit(this.manifestPublishedTopic, event.deviceId, event);
  }

  async emitPlayerUpdateFailed(event: PlayerUpdateFailedEvent): Promise<void> {
    await this.emit(this.playerUpdateFailedTopic, event.deviceId, event);
  }

  private async emit(
    topic: string,
    key: string,
    event:
      | SchedulerEvaluationCompletedEvent
      | PlayerManifestPublishedEvent
      | PlayerUpdateFailedEvent,
  ): Promise<void> {
    if (!this.producer) return;

    await this.producer.send({
      topic,
      messages: [
        {
          key,
          value: JSON.stringify(event),
          headers: {
            eventType: event.eventType,
            schemaVersion: String(event.schemaVersion),
            deviceId: event.deviceId,
          },
        },
      ],
    });
  }

  async close(): Promise<void> {
    if (!this.producer) return;
    await this.producer.disconnect();
    this.producer = null;
    logger.info('Redpanda producer disconnected');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }
}
