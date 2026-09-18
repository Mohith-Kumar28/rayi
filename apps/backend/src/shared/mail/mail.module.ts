import { Global, Module } from '@nestjs/common';

import { PrismaModule } from '@/database/prisma.module';

import { MailService } from './mail.service';

/**
 * Global, because the auth stack and the queue both reach for it.
 *
 * No transport module to configure: Resend is an HTTPS client built from one API
 * key, so there is no connection pool, no TLS negotiation and no template engine
 * to wire up. `MailService` reads `ConfigService`, which is already global.
 *
 * `PrismaModule` is back — not to look users up (that is the caller's job, and
 * the caller already does it) but to check the SUPPRESSION list before sending.
 * That check belongs here rather than in each caller: a caller that forgot it
 * would keep mailing a dead address, and the damage is to every other user's
 * deliverability rather than to the caller's own feature.
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
