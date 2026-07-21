import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Consumer, Kafka, logLevel } from 'kafkajs';
import { createLogger } from '../common/logger';

const logger = createLogger('SchedulerEventConsumerService');

@Injectable()
export class SchedulerEventConsumerService implements OnApplicationShutdown {
  private consumer: Consumer | null = null;

  constructor(
    private readonly brokers: string[],
    private readonly clientId: string,
    private readonly groupId: string,
    private readonly topics: string[],
    private readonly enabled = false,
  ) {}

  async start(): Promise<void> {
    if (!this.enabled || this.brokers.length === 0 || this.topics.length === 0) {
      logger.info('Scheduler Redpanda debug consumer disabled');
      return;
    }

    const kafka = new Kafka({
      clientId: `${this.clientId}-consumer`,
      brokers: this.brokers,
      connectionTimeout: 1000,
      requestTimeout: 2000,
      retry: { retries: 1, initialRetryTime: 100 },
      logLevel: logLevel.NOTHING,
    });

    this.consumer = kafka.consumer({ groupId: this.groupId });
    await this.consumer.connect();

    for (const topic of this.topics) {
      await this.consumer.subscribe({ topic, fromBeginning: false });
    }

    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        logger.info(
          `Redpanda event observed topic=${topic} partition=${partition} offset=${message.offset} key=${message.key?.toString() || ''}`,
        );
      },
    });

    logger.info(`Scheduler Redpanda debug consumer subscribed: ${this.topics.join(', ')}`);
  }

  async close(): Promise<void> {
    if (!this.consumer) return;
    await this.consumer.disconnect();
    this.consumer = null;
    logger.info('Scheduler Redpanda debug consumer disconnected');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }
}
