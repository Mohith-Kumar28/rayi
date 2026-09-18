import { getConfig as getAppConfig } from '@/config/app/app.config';
import { RedisConfig } from '@/config/redis/redis-config.type';
import redisConfig from '@/config/redis/redis.config';
import validateConfig from '@/utils/config/validate-config';
import { registerAs } from '@nestjs/config';
import { IsBoolean, IsNumber, IsOptional } from 'class-validator';
import { BullConfig } from './bull-config.type';

export const BULL_BOARD_PATH = '/queues';

class EnvironmentVariablesValidator {
  @IsBoolean()
  @IsOptional()
  QUEUE_REMOVE_ON_COMPLETE: boolean;

  @IsNumber()
  @IsOptional()
  RETRY_ATTEMPTS_ON_FAIL: number;
}

export function getConfig(): BullConfig {
  const appPrefix = getAppConfig().appPrefix;
  return {
    prefix: `${appPrefix}:bull`,
    redis: redisConfig() as RedisConfig,
    defaultJobOptions: {
      removeOnComplete: process.env.QUEUE_REMOVE_ON_COMPLETE === 'true',
      removeOnFail: process.env.QUEUE_REMOVE_ON_FAIL === 'true',
      attempts: process.env.QUEUE_FAILED_RETRY_ATTEMPTS
        ? Number.parseInt(process.env.QUEUE_FAILED_RETRY_ATTEMPTS)
        : 0,
      backoff: {
        type: 'exponential', // With an exponential backoff, it will retry after 2 ^ attempts * delay milliseconds
        delay: 1000,
      },
    },
  };
}

export default registerAs<BullConfig>('queue', () => {
  // eslint-disable-next-line no-console
  console.info(`Registering BullConfig from environment variables`);
  validateConfig(process.env, EnvironmentVariablesValidator);
  return getConfig();
});
