import { PrismaService } from '@/database/prisma.service';
import { MailService } from '@/shared/mail/mail.service';
import { Injectable, Logger } from '@nestjs/common';
import {
  EmailChangeConfirmJob,
  EmailChangeNoticeJob,
  EmailVerificationJob,
  ResetPasswordJob,
  SignInMagicLinkJob,
} from './email.type';

@Injectable()
export class EmailQueueService {
  private logger = new Logger(this.constructor.name);

  constructor(
    private readonly mailService: MailService,
    private readonly prisma: PrismaService,
  ) {}

  async verifyEmail(data: EmailVerificationJob['data']): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { id: data.userId, deletedAt: null },
    });
    if (!user) {
      this.logger.error(`User id = ${data.userId} does not exist.`);
      return;
    }
    await this.mailService.sendEmailVerificationMail({
      email: user.email,
      url: data.url,
    });
  }

  async sendMagicLink(data: SignInMagicLinkJob['data']): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { email: data.email, deletedAt: null },
    });
    if (!user) {
      return;
    }
    await this.mailService.sendAuthMagicLinkMail({
      email: user.email,
      url: data.url,
    });
  }

  /**
   * The confirmation link, to the NEW address.
   *
   * No user lookup: the address is not the user's current one, so there is
   * nothing to look up. The address came from a request that already passed
   * step-up.
   */
  async emailChangeConfirm(data: EmailChangeConfirmJob['data']): Promise<void> {
    await this.mailService.sendEmailChangeConfirmMail(data);
  }

  /**
   * The warning, to the OLD address.
   *
   * Also no lookup — by the time this runs the user row may already carry the
   * new address, and notifying the new one would tell the attacker rather than
   * the owner.
   */
  async emailChangeNotice(data: EmailChangeNoticeJob['data']): Promise<void> {
    await this.mailService.sendEmailChangeNoticeMail(data);
  }

  async resetPassword(data: ResetPasswordJob['data']): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { id: data.userId, deletedAt: null },
    });
    if (!user) {
      return;
    }
    await this.mailService.sendResetPasswordMail({
      email: user.email,
      url: data.url,
    });
  }
}
