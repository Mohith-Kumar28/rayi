import { MailTemplate } from '@/constants/mail.constant';
import { MailerService } from '@nestjs-modules/mailer';
import { Injectable } from '@nestjs/common';

@Injectable()
export class MailService {
  constructor(private readonly mailerService: MailerService) {}

  async sendEmailVerificationMail({
    email,
    url,
  }: {
    email: string;
    url: string;
  }) {
    await this.mailerService.sendMail({
      to: email,
      subject: 'Verify your Email',
      template: MailTemplate.EmailVerification,
      context: {
        email: email,
        url,
      },
    });
  }

  async sendAuthMagicLinkMail({ email, url }: { email: string; url: string }) {
    await this.mailerService.sendMail({
      to: email,
      subject: 'Magic Link',
      template: MailTemplate.SignInMagicLink,
      context: {
        email: email,
        url,
      },
    });
  }

  async sendResetPasswordMail({ email, url }: { email: string; url: string }) {
    await this.mailerService.sendMail({
      to: email,
      subject: 'Reset Password',
      template: MailTemplate.ResetPassword,
      context: {
        email: email,
        url,
      },
    });
  }
}
