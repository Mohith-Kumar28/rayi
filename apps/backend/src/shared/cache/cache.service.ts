import { GlobalConfig } from '@/config/config.type';
import { CacheKey } from '@/constants/cache.constant';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cache } from 'cache-manager';
import util from 'util';
import { CacheParam } from './cache.type';

@Injectable()
export class CacheService {
  constructor(
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache,
    private readonly configService: ConfigService<GlobalConfig>,
  ) {}

  async get<T>(keyParams: CacheParam) {
    return this.cacheManager.get<T>(this._constructCacheKey(keyParams));
  }

  /**
   * Return remaining ttl of a key if it was set.
   * By default -1 and -2 cases are obfuscated to avoid confusion but if `disableResponseFilter = true`:
   * -1: If key exists but has no expiry
   * -2: If key does not exist at all
   */
  async getTtl(
    keyParams: CacheParam,
    options?: { disableResponseFilter?: false },
  ): Promise<number | null> {
    const ttl = await this.cacheManager.ttl(this._constructCacheKey(keyParams));

    if (!options?.disableResponseFilter && [-1, -2].includes(ttl)) {
      return null;
    }
    return ttl ?? null;
  }

  async set(
    keyParams: CacheParam,
    value: unknown,
    options?: {
      /**
       * In milliseconds
       */
      ttl?: number;
    },
  ): Promise<{ key: string }> {
    const key = this._constructCacheKey(keyParams);
    await this.cacheManager.set(key, value, options?.ttl);
    return { key };
  }

  async storeGet<T>(keyParams: CacheParam) {
    return this.cacheManager.get<T>(this._constructCacheKey(keyParams));
  }

  async storeSet<T>(
    keyParams: CacheParam,
    value: T,
    options?: {
      /**
       * In milliseconds
       */
      ttl?: number;
    },
  ): Promise<{ key: string }> {
    const key = this._constructCacheKey(keyParams);
    await this.cacheManager.set<T>(
      this._constructCacheKey(keyParams),
      value,
      options?.ttl,
    );
    return { key };
  }

  async delete(keyParams: CacheParam): Promise<{ key: string }> {
    const key = this._constructCacheKey(keyParams);
    await this.cacheManager.del(key);
    return { key };
  }

  private _constructCacheKey(keyParams: CacheParam): string {
    const prefix = this.configService.get('app.appPrefix', { infer: true });
    return util.format(
      `${prefix}:${CacheKey[keyParams.key]}`,
      ...(keyParams.args ?? []),
    );
  }
}
