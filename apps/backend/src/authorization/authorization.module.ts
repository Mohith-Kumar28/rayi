import { Module } from '@nestjs/common';

import { PrismaModule } from '@/database/prisma.module';

import { AccessControlAssertion } from './access-control.assertion';
import { PermissionService } from './permission.service';

/**
 * Authorization. Answers "may this member do this, in this tenant".
 *
 * Exports only the service — no repository, no Prisma handle. The narrowness IS
 * the interface: everything else in the app asks a question and gets a boolean,
 * rather than being handed the ability to query permissions any way it likes.
 */
@Module({
  imports: [PrismaModule],
  providers: [PermissionService, AccessControlAssertion],
  exports: [PermissionService],
})
export class AuthorizationModule {}
