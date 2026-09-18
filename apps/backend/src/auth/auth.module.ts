import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullModule } from '@nestjs/bullmq';
import type {
  MiddlewareConsumer,
  NestModule,
  OnModuleInit,
} from '@nestjs/common';
import { Global, Inject, Logger, Module } from '@nestjs/common';
import {
  DiscoveryModule,
  DiscoveryService,
  HttpAdapterHost,
  MetadataScanner,
} from '@nestjs/core';
import { betterAuth, type Auth } from 'better-auth';

import { getConfig as getBetterAuthConfig } from '@/config/auth/better-auth.config';
import { GlobalConfig } from '@/config/config.type';
import {
  AFTER_HOOK_KEY,
  AUTH_INSTANCE_KEY,
  BEFORE_HOOK_KEY,
  HOOK_KEY,
} from '@/constants/auth.constant';
import { Queue } from '@/constants/job.constant';
import { PrismaModule } from '@/database/prisma.module';
import { PrismaService } from '@/database/prisma.service';
import { CacheModule } from '@/shared/cache/cache.module';
import { CacheService } from '@/shared/cache/cache.service';
import { ConfigService } from '@nestjs/config';
import { createAuthMiddleware } from 'better-auth/api';
import type {
  FastifyInstance,
  FastifyReply as Reply,
  FastifyRequest as Request,
} from 'fastify';
import { shouldServeAuthRequest } from './auth-route-allowlist';
import { AuthService } from './auth.service';
import { BetterAuthService } from './better-auth.service';

const HOOKS = [
  { metadataKey: BEFORE_HOOK_KEY, hookType: 'before' as const },
  { metadataKey: AFTER_HOOK_KEY, hookType: 'after' as const },
];

@Global()
@Module({
  imports: [
    DiscoveryModule,
    BullModule.registerQueue({
      name: Queue.Email,
    }),
    BullBoardModule.forFeature({
      name: Queue.Email,
      adapter: BullMQAdapter,
    }),
    PrismaModule,
  ],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule implements NestModule, OnModuleInit {
  private logger = new Logger(this.constructor.name);

  constructor(
    @Inject(AUTH_INSTANCE_KEY) private readonly auth: Auth,
    @Inject(DiscoveryService)
    private discoveryService: DiscoveryService,
    @Inject(MetadataScanner)
    private metadataScanner: MetadataScanner,
    @Inject(HttpAdapterHost)
    private readonly adapter: HttpAdapterHost,
  ) {}

  onModuleInit() {
    if (!this.auth.options.hooks) return;

    const providers = this.discoveryService
      .getProviders()
      .filter(
        ({ metatype }) => metatype && Reflect.getMetadata(HOOK_KEY, metatype),
      );

    for (const provider of providers) {
      const providerPrototype = Object.getPrototypeOf(provider.instance);
      const methods = this.metadataScanner.getAllMethodNames(providerPrototype);

      for (const method of methods) {
        const providerMethod = providerPrototype[method];
        this.setupHooks(providerMethod);
      }
    }
  }

  configure(_: MiddlewareConsumer) {
    let basePath = this.auth.options.basePath ?? '/api/auth';

    // Ensure the basePath starts with / and doesn't end with /
    if (!basePath.startsWith('/')) {
      basePath = '/' + basePath;
    }
    if (basePath.endsWith('/')) {
      basePath = basePath.slice(0, -1);
    }

    (this.adapter.httpAdapter.getInstance() as FastifyInstance).all(
      `${basePath}/*`,
      async (request: Request, reply: Reply) => {
        try {
          const url = new URL(
            request.url,
            `${request.protocol}://${request.hostname}`,
          );

          // DENY BY DEFAULT, before Better Auth sees the request.
          //
          // This handler serves and returns BEFORE Nest's guard chain runs, so
          // AuthGuard and PermissionGuard never see these paths — and neither
          // does the route-coverage test, which enumerates Nest routes. Without
          // this check, all 42 of Better Auth's endpoints are internet-reachable
          // with no MFA, no step-up, no audit row and no authorization of ours.
          //
          // 404 rather than 403: a 403 confirms the endpoint exists and is
          // merely blocked, which tells an attacker the version and the plugin
          // set. A 404 is indistinguishable from software that lacks the feature.
          if (!shouldServeAuthRequest(basePath, request.method, request.url)) {
            this.logger.warn(
              `Blocked non-allowlisted auth route: ${request.method} ${url.pathname}`,
            );
            reply.status(404).send({ message: 'Not found' });
            return;
          }

          const headers = new Headers();
          Object.entries(request.headers).forEach(([key, value]) => {
            if (value) headers.append(key, value.toString());
          });

          const req = new Request(url.toString(), {
            method: request.method,
            headers,
            body: request.body ? JSON.stringify(request.body) : undefined,
          });

          const response = await this.auth.handler(req);

          reply.status(response.status);
          response.headers.forEach((value, key) => reply.header(key, value));
          reply.send(
            response.body
              ? await response.text()
              : {
                  status: response.status,
                  message: response.statusText,
                },
          );
        } catch (error) {
          this.logger.fatal(`Better auth error ${String(error)}`);
          reply.status(500).send({
            error: 'Internal authentication error',
            code: 'AUTH_FAILURE',
          });
        }
      },
    );
    this.logger.log(`AuthModule initialized at '${basePath}/*'`);
  }

  private setupHooks(providerMethod: (ctx: any) => Promise<void>) {
    if (!this.auth.options.hooks) return;

    for (const { metadataKey, hookType } of HOOKS) {
      const hookPath = Reflect.getMetadata(metadataKey, providerMethod);
      if (!hookPath) continue;

      const originalHook = this.auth.options.hooks[hookType];
      this.auth.options.hooks[hookType] = createAuthMiddleware(async (ctx) => {
        if (originalHook) {
          await originalHook(ctx);
        }

        if (hookPath === ctx.path) {
          await providerMethod(ctx);
        }
      });
    }
  }

  static forRootAsync() {
    return {
      global: true,
      module: AuthModule,
      imports: [CacheModule],
      providers: [
        {
          provide: AUTH_INSTANCE_KEY,
          useFactory: async (
            cacheService: CacheService,
            configService: ConfigService<GlobalConfig>,
            authService: AuthService,
            prismaService: PrismaService,
          ) => {
            const config = getBetterAuthConfig({
              cacheService,
              configService,
              authService,
              prismaService,
            });
            return betterAuth(config);
          },
          inject: [CacheService, ConfigService, AuthService, PrismaService],
        },
        BetterAuthService,
      ],
      exports: [AUTH_INSTANCE_KEY, BetterAuthService],
    };
  }
}
