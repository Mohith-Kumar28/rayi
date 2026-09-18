import { AUTH_INSTANCE_KEY } from '@/constants/auth.constant';
import { Inject, Injectable } from '@nestjs/common';
import type { Auth } from 'better-auth/auth';

/**
 * NOTE: This service is solely for handling better auth related tasks.
 * You cannot import `auth.service.ts` here since AuthService is used inside `better-auth.config.ts` and will cause a circular loop.
 */
@Injectable()
export class BetterAuthService {
  constructor(
    @Inject(AUTH_INSTANCE_KEY)
    private readonly auth: Auth,
  ) {}

  // Explicitly annotated. With `declaration: true` and pnpm's nested store,
  // TypeScript cannot name the inferred type portably (TS2742) because it
  // reaches into zod's internals via a path that does not exist from here.
  get api(): Auth['api'] {
    return this.auth.api;
  }
}
