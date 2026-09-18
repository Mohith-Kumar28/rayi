import { AuthService } from '@/auth/auth.service';
import { GlobalConfig } from '@/config/config.type';
import { PrismaService } from '@/database/prisma.service';
import { CacheService } from '@/shared/cache/cache.service';
import { validateUsername } from '@/utils/validators/username';
import { ConfigService } from '@nestjs/config';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError } from 'better-auth/api';
import { magicLink, openAPI, twoFactor, username } from 'better-auth/plugins';
import { BetterAuthOptions, BetterAuthPlugin } from 'better-auth/types';
import { v4 as uuid } from 'uuid';

/**
 * Better Auth Configuration
 * Visit https://www.better-auth.com/docs/reference/options to see full options
 * Visit `/api/auth/reference` to see all the API references integrated in this better auth instance
 */
export function getConfig({
  configService,
  cacheService,
  authService,
  prismaService,
}: {
  configService: ConfigService<GlobalConfig>;
  cacheService: CacheService;
  authService: AuthService;
  prismaService: PrismaService;
}): BetterAuthOptions {
  const appConfig = configService.getOrThrow('app', { infer: true });
  const authConfig = configService.getOrThrow('auth', { infer: true });

  // Core plugins
  const plugins: BetterAuthPlugin[] = [
    username({ usernameValidator: validateUsername }),
    magicLink({
      disableSignUp: true,
      async sendMagicLink({ email, url }) {
        try {
          await authService.sendSigninMagicLink({ email, url });
        } catch (error: any) {
          throw new APIError(error.status, {
            status: error.status,
            message: error.message,
          });
        }
      },
    }),
    twoFactor(),
  ];

  // Plugins for development only
  const nonProdPlugins = [openAPI()];
  if (appConfig.nodeEnv !== 'production') {
    plugins.push(...nonProdPlugins);
  }

  return {
    appName: appConfig.name,
    secret: authConfig.authSecret,
    baseURL: appConfig.url,
    plugins,
    database: prismaAdapter(prismaService, {
      provider: 'postgresql',
    }),
    emailAndPassword: {
      enabled: true,
      autoSignIn: false,
      requireEmailVerification: true,
      sendResetPassword: async ({ url, user }) => {
        try {
          await authService.resetPassword({ url, userId: user.id });
        } catch (error: any) {
          throw new APIError(error.status, {
            status: error.status,
            message: error.message,
          });
        }
      },
    },
    session: {
      freshAge: 0, // We perform every sensitive operation via our own API so this is irrelevant.
    },
    user: {
      fields: {
        name: 'firstName',
        emailVerified: 'isEmailVerified',
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        try {
          await authService.verifyEmail({ url, userId: user.id });
        } catch (error: any) {
          throw new APIError(error.status, {
            status: error.status,
            message: error.message,
          });
        }
      },
    },
    trustedOrigins: appConfig.corsOrigin as string[],
    socialProviders: {
      ...(authConfig.oAuth.github?.clientId &&
      authConfig.oAuth.github?.clientSecret
        ? {
            github: {
              clientId: authConfig.oAuth.github?.clientId,
              clientSecret: authConfig.oAuth.github?.clientSecret,
              mapProfileToUser(profile) {
                return {
                  email: profile.email,
                  name: profile.login,
                  username: profile.login,
                  emailVerified: true,
                  image: profile.avatar_url,
                };
              },
            },
          }
        : {}),
    },
    advanced: {
      database: {
        generateId() {
          return uuid();
        },
      },
      cookiePrefix: 'TmVzdEpTIEJvaWxlcnBsYXRl',
    },
    // Use Redis for storing sessions
    secondaryStorage: {
      get: async (key) => {
        return (
          (await cacheService.get({ key: 'AccessToken', args: [key] })) ?? null
        );
      },
      set: async (key, value, ttl) => {
        await cacheService.set(
          { key: 'AccessToken', args: [key] },
          value,
          ttl
            ? {
                ttl: ttl * 1000,
              }
            : {},
        );
      },
      delete: async (key) => {
        await cacheService.delete({ key: 'AccessToken', args: [key] });
      },
      // Added in better-auth 1.7: atomically read-then-remove, used for
      // single-use tokens where a replay must not succeed.
      getAndDelete: async (key) => {
        const value =
          (await cacheService.get({ key: 'AccessToken', args: [key] })) ?? null;
        await cacheService.delete({ key: 'AccessToken', args: [key] });
        return value as string | null;
      },
      // Added in better-auth 1.7, used by the built-in rate limiter.
      //
      // NOTE: this is a read-modify-write and is therefore NOT atomic under
      // concurrency, so counts can be undercounted by racing requests. That is
      // acceptable here only because the authoritative rate limit lives at the
      // edge (CloudFront/WAF) and @nestjs/throttler backed by Redis — Better
      // Auth's own limiter has had a documented bypass (CVE-2026-45364) and is
      // treated as defence in depth, never as the control. Replace with a real
      // Redis INCR if this ever becomes load-bearing.
      increment: async (key) => {
        const current = await cacheService.get({
          key: 'AccessToken',
          args: [key],
        });
        const next =
          (typeof current === 'number' ? current : Number(current ?? 0)) + 1;
        await cacheService.set(
          { key: 'AccessToken', args: [key] },
          next as never,
          {},
        );
        return next;
      },
    },
  };
}
