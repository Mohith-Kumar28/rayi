import { PrismaService } from '@/database/prisma.service';
import { MailService } from '@/shared/mail/mail.service';
import { Injectable, Logger } from '@nestjs/common';
import {
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
