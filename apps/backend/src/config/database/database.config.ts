import validateConfig from '@/utils/config/validate-config';
import { registerAs } from '@nestjs/config';
import { IsString, ValidateIf } from 'class-validator';
import { DatabaseConfig } from './database-config.type';

class EnvironmentVariablesValidator {
  @ValidateIf((envValues) => envValues.DATABASE_URL)
  @IsString()
  DATABASE_URL: string;
}

export function getConfig(): DatabaseConfig {
  return {
    url: process.env.DATABASE_URL,
  };
}

export default registerAs<DatabaseConfig>('database', () => {
  // eslint-disable-next-line no-console
  console.info(`Registering DatabaseConfig from environment variables`);
  validateConfig(process.env, EnvironmentVariablesValidator);
  return getConfig();
});
