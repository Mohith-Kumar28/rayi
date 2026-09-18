import { requireEnv } from '@/utils/config/require-env';
import validateConfig from '@/utils/config/validate-config';
import { registerAs } from '@nestjs/config';
import { IsNotEmpty, IsString, Matches } from 'class-validator';
import { DatabaseConfig } from './database-config.type';

/**
 * The database connection.
 *
 * The inherited version used `@ValidateIf((env) => env.DATABASE_URL)`, which
 * only validates the variable IF IT IS PRESENT — so a missing DATABASE_URL
 * passed validation and the process started without a database, failing later at
 * the first query. For a payments backend that is the wrong failure: it should
 * die at boot, before binding a port, not halfway through serving a request.
 */
class EnvironmentVariablesValidator {
  @IsString()
  @IsNotEmpty()
  @Matches(/^postgres(ql)?:\/\//, {
    message: 'DATABASE_URL must be a PostgreSQL connection string.',
  })
  DATABASE_URL: string;
}

export function getConfig(): DatabaseConfig {
  return {
    url: requireEnv('DATABASE_URL'),
  };
}

export default registerAs<DatabaseConfig>('database', () => {
  validateConfig(process.env, EnvironmentVariablesValidator);
  return getConfig();
});
