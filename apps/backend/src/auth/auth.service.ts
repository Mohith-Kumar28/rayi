import { GlobalConfig } from '@/config/config.type';
import { Queue } from '@/constants/job.constant';
import { PrismaService } from '@/database/prisma.service';
import { CacheService } from '@/shared/cache/cache.service';
import { CacheParam } from '@/shared/cache/cache.type';
import { EmailQueue } from '@/worker/queues/email/email.type';
import { InjectQueue } from '@nestjs/bullmq';
import {
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * NOTE: This service is for handling auth related tasks outside of Better Auth.
 * You cannot import better auth instance from `better-auth.service.ts` here since we already use this service to create Better Auth instance and will cause a circular loop.
 */
@Injectable()
export class AuthService {
  constructor(
    private configService: ConfigService<GlobalConfig>,
    @InjectQueue(Queue.Email)
    private readonly emailQueue: EmailQueue,
    private readonly cacheService: CacheService,
    private readonly prisma: PrismaService,
  ) {}

  async sendSigninMagicLink({ email, url }: { email: string; url: string }) {
    const user = await this.prisma.user.findFirst({
      where: {
        email,
        deletedAt: null,
      },
      select: {
        id: true,
      },
    });
    if (!user) {
      throw new NotFoundException('User not found.');
    }

    // Rate limited to 1 email per 30 seconds
    const cacheKey: CacheParam = {
      key: 'SignInMagicLinkMailLastSentAt',
      args: [user.id],
    };
    const remainingTtl = await this.cacheService.getTtl(cacheKey);
    if (!(remainingTtl == null) && remainingTtl !== 0) {
      throw new HttpException(
        `Too many requests. Please wait ${Math.floor(remainingTtl / 1000)} seconds before sending again.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    await this.emailQueue.add('signin-magic-link', {
      email,
      url,
    });

    await this.cacheService.set(cacheKey, +new Date(), { ttl: 30_000 });
  }

  async verifyEmail({ url, userId }: { url: string; userId: string }) {
    // Rate limited to 1 email per 30 seconds
    const cacheKey: CacheParam = {
      key: 'EmailVerificationMailLastSentAt',
      args: [userId],
    };
    const remainingTtl = await this.cacheService.getTtl(cacheKey);
    if (!(remainingTtl == null) && remainingTtl !== 0) {
      throw new HttpException(
        `Too many requests. Please wait ${Math.floor(remainingTtl / 1000)} seconds before sending again.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    await this.emailQueue.add('email-verification', {
      url,
      userId,
    });

    await this.cacheService.set(cacheKey, +new Date(), { ttl: 30_000 });
  }

  async resetPassword({ url, userId }: { url: string; userId: string }) {
    // Rate limited to 1 email per 30 seconds
    const cacheKey: CacheParam = {
      key: 'ResetPasswordMailLastSentAt',
      args: [userId],
    };
    const remainingTtl = await this.cacheService.getTtl(cacheKey);
    if (!(remainingTtl == null) && remainingTtl !== 0) {
      throw new HttpException(
        `Too many requests. Please wait ${Math.floor(remainingTtl / 1000)} seconds before sending again.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    await this.emailQueue.add('reset-password', {
      url,
      userId,
    });
    await this.cacheService.set(cacheKey, +new Date(), { ttl: 30_000 });
  }

  /**
   * Creates a basic auth username:password header that you can pass for API that is protected behind `basicAuthMiddleware`
   */
  createBasicAuthHeaders() {
    const username = this.configService.getOrThrow('auth.basicAuth.username', {
      infer: true,
    });
    const password = this.configService.getOrThrow('auth.basicAuth.password', {
      infer: true,
    });
    const base64Credential = Buffer.from(`${username}:${password}`).toString(
      'base64',
    );
    return {
      Authorization: `Basic ${base64Credential}`,
    };
  }
}
