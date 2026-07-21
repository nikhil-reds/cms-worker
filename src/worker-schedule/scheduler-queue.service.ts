import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import { createLogger } from '../common/logger';
import { SchedulerService } from './scheduler.service';
import type { SchedulerEvaluateNowJob } from './scheduler-job.types';

const logger = createLogger('SchedulerQueueService');

@Injectable()
export class SchedulerQueueService implements OnApplicationShutdown {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private consumerTag: string | null = null;
  private metricsInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly scheduler: SchedulerService,
    private readonly rabbitmqUrl: string,
    private readonly queueName: string,
    private readonly retryQueueName: string,
    private readonly deadLetterQueueName: string,
    private readonly prefetch: number,
    private readonly maxRetries: number,
    private readonly retryDelayMs: number,
    private readonly metricsIntervalMs: number,
    private readonly enabled = true,
  ) {}

  async start(): Promise<void> {
    if (!this.enabled) {
      logger.info('RabbitMQ scheduler queue consumer disabled');
      return;
    }

    this.connection = await amqp.connect(this.rabbitmqUrl);
    this.channel = await this.connection.createChannel();
    await this.assertQueues(this.channel);
    await this.channel.prefetch(this.prefetch);

    const result = await this.channel.consume(
      this.queueName,
      (message) => {
        if (!message) return;
        this.handleMessage(message).catch((error) => {
          logger.error('Unexpected RabbitMQ message handler failure', error);
        });
      },
      { noAck: false },
    );

    this.consumerTag = result.consumerTag;
    logger.info(
      `Consuming RabbitMQ queue ${this.queueName} (prefetch=${this.prefetch})`,
    );

    this.startMetrics();
  }

  private async assertQueues(channel: Channel): Promise<void> {
    await channel.assertQueue(this.deadLetterQueueName, {
      durable: true,
      arguments: { 'x-queue-type': 'classic' },
    });

    await channel.assertQueue(this.queueName, {
      durable: true,
      arguments: { 'x-queue-type': 'classic' },
    });

    await channel.assertQueue(this.retryQueueName, {
      durable: true,
      arguments: {
        'x-queue-type': 'classic',
        'x-message-ttl': this.retryDelayMs,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': this.queueName,
      },
    });
  }

  private async handleMessage(message: ConsumeMessage): Promise<void> {
    if (!this.channel) return;

    try {
      const job = JSON.parse(message.content.toString('utf8')) as SchedulerEvaluateNowJob;
      if (job.type !== 'scheduler.evaluate.now') {
        throw new Error(`Unsupported scheduler job type: ${job.type}`);
      }

      await this.scheduler.evaluateNow(job);
      this.channel.ack(message);
    } catch (error) {
      logger.error('Scheduler job failed', error);
      await this.retryOrDeadLetter(message, error);
    }
  }

  private async retryOrDeadLetter(
    message: ConsumeMessage,
    error: unknown,
  ): Promise<void> {
    if (!this.channel) return;

    const retries = Number(message.properties.headers?.retries || 0);
    const nextRetries = retries + 1;
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (nextRetries > this.maxRetries) {
      this.channel.sendToQueue(this.deadLetterQueueName, message.content, {
        persistent: true,
        contentType: message.properties.contentType,
        messageId: message.properties.messageId,
        type: message.properties.type,
        timestamp: Math.floor(Date.now() / 1000),
        headers: {
          ...message.properties.headers,
          retries,
          failedAt: new Date().toISOString(),
          error: errorMessage,
        },
      });
      this.channel.ack(message);
      logger.error(
        `Scheduler job moved to DLQ ${this.deadLetterQueueName} after ${retries} retries`,
      );
      return;
    }

    this.channel.sendToQueue(this.retryQueueName, message.content, {
      persistent: true,
      contentType: message.properties.contentType,
      messageId: message.properties.messageId,
      type: message.properties.type,
      timestamp: Math.floor(Date.now() / 1000),
      headers: {
        ...message.properties.headers,
        retries: nextRetries,
        retryAt: new Date(Date.now() + this.retryDelayMs).toISOString(),
        error: errorMessage,
      },
    });
    this.channel.ack(message);
    logger.warn(
      `Scheduler job retry ${nextRetries}/${this.maxRetries} queued in ${this.retryQueueName}`,
    );
  }

  private startMetrics(): void {
    if (!this.channel || this.metricsIntervalMs <= 0) return;

    this.metricsInterval = setInterval(() => {
      this.logQueueMetrics().catch((error) =>
        logger.error('Could not collect RabbitMQ scheduler queue metrics', error),
      );
    }, this.metricsIntervalMs);
  }

  private async logQueueMetrics(): Promise<void> {
    if (!this.channel) return;

    const [main, retry, deadLetter] = await Promise.all([
      this.channel.checkQueue(this.queueName),
      this.channel.checkQueue(this.retryQueueName),
      this.channel.checkQueue(this.deadLetterQueueName),
    ]);

    logger.info(
      `Scheduler queue lag: ${this.queueName} ready=${main.messageCount} consumers=${main.consumerCount}; ` +
        `${this.retryQueueName} ready=${retry.messageCount}; ` +
        `${this.deadLetterQueueName} ready=${deadLetter.messageCount}`,
    );
  }

  async stop(): Promise<void> {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }

    if (this.channel && this.consumerTag) {
      await this.channel.cancel(this.consumerTag);
    }

    if (this.channel) {
      await this.channel.close();
      this.channel = null;
    }

    if (this.connection) {
      await this.connection.close();
      this.connection = null;
    }

    this.consumerTag = null;
    logger.info('RabbitMQ scheduler queue consumer stopped');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }
}
