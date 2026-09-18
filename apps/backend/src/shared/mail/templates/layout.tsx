import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Preview,
  Section,
  Tailwind,
  Text,
} from '@react-email/components';
import * as React from 'react';

/**
 * The shell every Rayi email renders inside.
 *
 * One place for the footer, the wordmark and the spacing, so a new template
 * cannot quietly ship without the "we will never ask you for..." line — which
 * is the only part of these emails that does any security work.
 *
 * No remote images and no web fonts. A tracking pixel or a hosted font in a
 * transactional email tells a network observer, and the font host, exactly when
 * a specific person opened a sign-in link.
 */
export function Layout({
  preview,
  children,
}: {
  /** The one line shown in an inbox list, before the message is opened. */
  preview: string;
  children: React.ReactNode;
}) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Tailwind>
        <Body className="bg-[#f6f6f4] font-sans py-10">
          <Container className="bg-white max-w-[520px] mx-auto rounded-2xl border border-[#e7e5e0] px-10 py-9">
            <Text className="text-[15px] font-semibold tracking-tight text-[#191919] m-0 mb-7">
              Rayi
            </Text>

            {children}

            <Hr className="border-[#e7e5e0] my-7" />

            <Section>
              <Text className="text-[12px] leading-[18px] text-[#6b6b6b] m-0">
                Rayi will never ask you for a password, a bank login, or a code from this email.
                If you did not expect this message, you can ignore it — no action will be taken.
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}

/**
 * The call-to-action, with the destination printed underneath.
 *
 * The visible URL is not decoration. A recipient who cannot see where a button
 * goes has no way to tell a real sign-in link from a lookalike domain, and these
 * are exactly the emails worth imitating.
 */
export function Action({ href, label }: { href: string; label: string }) {
  return (
    <>
      <Section className="my-7">
        <a
          href={href}
          className="bg-[#191919] text-white text-[14px] font-medium no-underline rounded-lg px-5 py-3 inline-block"
        >
          {label}
        </a>
      </Section>
      <Text className="text-[12px] leading-[18px] text-[#6b6b6b] m-0">
        Or paste this into your browser:
      </Text>
      <Text className="text-[12px] leading-[18px] text-[#6b6b6b] m-0 break-all">{href}</Text>
    </>
  );
}
