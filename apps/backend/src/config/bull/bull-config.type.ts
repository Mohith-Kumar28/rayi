import { RedisConfig } from '@/config/redis/redis-config.type';
import { JobsOptions } from 'bullmq';

export type BullConfig = {
  prefix: string;
  redis: RedisConfig;
  defaultJobOptions: JobsOptions;
};
