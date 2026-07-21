import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { createLogger } from './common/logger';

const logger = createLogger('Main');

async function bootstrap() {
  try {
    logger.info('Starting Media Sync Worker...');

    // Create headless application context (no HTTP server)
    const app = await NestFactory.createApplicationContext(AppModule);

    logger.info('✓ Application context created');
    logger.info('✓ Media Sync Worker is running');

    // Handle graceful shutdown
    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received, shutting down gracefully');
      await app.close();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      logger.info('SIGINT received, shutting down gracefully');
      await app.close();
      process.exit(0);
    });
  } catch (error) {
    logger.error('Failed to start Media Sync Worker', error);
    process.exit(1);
  }
}

bootstrap();
