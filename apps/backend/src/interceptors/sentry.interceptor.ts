import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import * as Sentry from '@sentry/node';
import 'dotenv/config';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { getConfig } from '../config/sentry/sentry.config';

const enableSentry = (err: Error, context: ExecutionContext) => {
  if (err instanceof HttpException) {
    return throwError(() => err);
  }

  Sentry.withScope((scope) => {
    const request = context.getArgs()[0];

    // Add request context
    if (request) {
      scope.setContext('request', {
        url: request.url,
        method: request.method,
        headers: request.headers,
        query: request.query,
        body: request.body,
        ip: request.ip,
        userAgent: request.headers?.['user-agent'],
      });
    }

    // Add execution context
    scope.setContext('execution', {
      type: context.getType(),
      handler: context.getHandler()?.name,
      class: context.getClass()?.name,
    });

    Sentry.captureException(err);
  });

  return throwError(() => err);
};

@Injectable()
export class SentryInterceptor implements NestInterceptor {
  intercept(
    context: ExecutionContext,
    next: CallHandler<any>,
  ): Observable<any> | Promise<Observable<any>> {
    const sentryConfig = getConfig();
    if (sentryConfig.logging) {
      return next
        .handle()
        .pipe(catchError((err) => enableSentry(err, context)));
    }
    return next.handle().pipe(catchError((err) => throwError(() => err)));
  }
}
