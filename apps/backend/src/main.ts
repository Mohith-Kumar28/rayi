import fastifyCookie from '@fastify/cookie';
import {
  ClassSerializerInterceptor,
  HttpStatus,
  UnprocessableEntityException,
  ValidationError,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory, Reflector } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import * as Sentry from '@sentry/node';
import helmet from 'helmet';
import { setupGracefulShutdown } from 'nestjs-graceful-shutdown';

import path from 'path';
import { AppModule } from './app.module';
import { getConfig as getAppConfig } from './config/app/app.config';
import { BULL_BOARD_PATH } from './config/bull/bull.config';
import { type GlobalConfig } from './config/config.type';
import { Environment } from './constants/app.constant';
import { SentryInterceptor } from './interceptors/sentry.interceptor';
import { basicAuthMiddleware } from './middlewares/basic-auth.middleware';
import { RedisIoAdapter } from './shared/socket/redis.adapter';
import { consoleLoggingConfig } from './tools/logger/logger-factory';
import setupSwagger, { SWAGGER_PATH } from './tools/swagger/swagger.setup';

async function bootstrap() {
  const envToLogger: Record<`${Environment}`, any> = {
    local: consoleLoggingConfig(),
    development: consoleLoggingConfig(),
    production: true,
    staging: true,
    test: false,
  } as const;

  const appConfig = getAppConfig();

  const isWorker = appConfig.isWorker;

  const app = await NestFactory.create<NestFastifyApplication>(
    isWorker ? AppModule.worker() : AppModule.main(),
    new FastifyAdapter({
      logger: appConfig.appLogging ? envToLogger[appConfig.nodeEnv] : false,
      trustProxy: appConfig.isHttps,
    }),
    {
      bufferLogs: true,
    },
  );

  const configService = app.get(ConfigService<GlobalConfig>);

  await app.register(fastifyCookie as any, {
    secret: configService.getOrThrow('auth.authSecret', {
      infer: true,
    }) as string,
  });

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      exceptionFactory: (errors: ValidationError[]) => {
        return new UnprocessableEntityException(errors);
      },
    }),
  );
  app.enableVersioning({
    type: VersioningType.URI,
  });

  app.enableCors({
    origin: configService.getOrThrow('app.corsOrigin', {
      infer: true,
    }),
    methods: ['GET', 'PATCH', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Accept',
    ],
    credentials: true,
  });

  const env = configService.getOrThrow('app.nodeEnv', { infer: true });

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: [
            "'self'",
            'https://cdn.jsdelivr.net/npm/@scalar/api-reference', // For Better Auth API Reference.
          ],
        },
      },
    }),
  );
  // Static files
  app.useStaticAssets({
    root: path.join(__dirname, '..', 'src', 'tmp', 'file-uploads'),
    prefix: '/public',
    setHeaders(res: any) {
      res.setHeader(
        'Access-Control-Allow-Origin',
        configService.getOrThrow('app.corsOrigin', {
          infer: true,
        }),
      );
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    },
  });

  const reflector = app.get(Reflector);
  app.useGlobalInterceptors(new ClassSerializerInterceptor(reflector));

  if (env !== 'production') {
    setupSwagger(app);
  }

  Sentry.init({
    dsn: configService.getOrThrow('sentry.dsn', { infer: true }),
    tracesSampleRate: 1.0,
    environment: env,
  });
  app.useGlobalInterceptors(new SentryInterceptor());

  if (env !== 'local') {
    setupGracefulShutdown({ app });
  }

  if (!isWorker) {
    app.useWebSocketAdapter(new RedisIoAdapter(app));
  }

  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', async (req: any, reply: any) => {
      const pathsToIntercept = [
        `/api${BULL_BOARD_PATH}`, // Bull-Board
        SWAGGER_PATH, // Swagger Docs
        `/api/auth/reference`, // Better Auth Docs
      ];
      if (pathsToIntercept.some((path) => req.url.startsWith(path))) {
        await basicAuthMiddleware(req, reply);
      }
    });

  await app.listen({
    port: isWorker
      ? configService.getOrThrow('app.workerPort', { infer: true })
      : configService.getOrThrow('app.port', { infer: true }),
    host: '0.0.0.0',
  });

  const httpUrl = await app.getUrl();
  // eslint-disable-next-line no-console
  console.info(
    `\x1b[3${isWorker ? '3' : '4'}m${isWorker ? 'Worker ' : ''}Server running at ${httpUrl}`,
  );

  return app;
}

void bootstrap();
