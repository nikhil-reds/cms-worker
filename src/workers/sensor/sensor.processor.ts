import { Injectable, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { SensorService } from './sensor.service';

@Injectable()
export class SensorProcessor implements OnApplicationBootstrap {
  private readonly logger = new Logger('SensorProcessor');

  constructor(private sensorService: SensorService) {}

  async onApplicationBootstrap(): Promise<void> {
    this.logger.log('⚡ Bootstrapping Sensor Worker');
    await this.sensorService.start();
  }
}
