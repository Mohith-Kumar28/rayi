import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  logger = new Logger('PrismaService');

  constructor() {
    const isDevelopment = process.env.NODE_ENV !== 'PROD';

    super({
      log: isDevelopment
        ? [
            { emit: 'stdout', level: 'query' },
            { emit: 'stdout', level: 'info' },
            { emit: 'stdout', level: 'warn' },
            { emit: 'stdout', level: 'error' },
          ]
        : [
            { emit: 'stdout', level: 'warn' },
            { emit: 'stdout', level: 'error' },
          ],
    });
  }

  async onModuleInit() {
    this.logger.log('Initializing Prisma client');
    await this.$connect();
  }

  async onApplicationShutdown() {
    this.logger.log('Disconnecting Prisma client');
    await this.$disconnect();
  }
}
