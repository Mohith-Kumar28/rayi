import { GlobalConfig } from '@/config/config.type';
import KeyvRedis from '@keyv/redis';
import { ConfigService } from '@nestjs/config';

async function useCacheFactory(config: ConfigService<GlobalConfig>) {
  const username = config.get<string>('redis.username', { infer: true });
  const password = config.get<string>('redis.password', { infer: true });
  const host = config.get<string>('redis.host', { infer: true });
  const port = config.get<number>('redis.port', { infer: true });
  return {
    stores: [
      new KeyvRedis({
        username: username || undefined,
        password: password || undefined,
        socket: {
          host,
          port,
          tls: config.get<boolean>('redis.tls', { infer: true }),
        },
      }),
    ],
  };
}

export default useCacheFactory;
