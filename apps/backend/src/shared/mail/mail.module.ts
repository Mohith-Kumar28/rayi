import { Global, Module } from '@nestjs/common';

import { MailService } from './mail.service';

/**
 * Global, because the auth stack and the queue both reach for it.
 *
 * No transport module to configure: Resend is an HTTPS client built from one API
 * key, so there is no connection pool, no TLS negotiation and no template engine
 * to wire up. `MailService` reads `ConfigService`, which is already global.
 *
 * `PrismaModule` is gone from here too — this module sends mail and does not
 * read the database. Looking a user up is the caller's job, and the caller was
 * already doing it.
 */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
