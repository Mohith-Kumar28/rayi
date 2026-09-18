import { Text } from '@react-email/components';
import * as React from 'react';

import { Action, Layout } from './layout';

interface SignInMagicLinkProps {
  email: string;
  url: string;
}

/**
 * The sign-in link.
 *
 * Props are REQUIRED — no `= '{{email}}'` defaults. The previous version carried
 * handlebars placeholders as default values because the template was compiled to
 * `.hbs` and interpolated at runtime. Rendered directly, those defaults would
 * silently ship an email reading "Hi {{email}}" with a button pointing at the
 * literal string `{{url}}` the moment a caller forgot a prop. Required props
 * make that a type error instead.
 *
 * `PreviewProps` is what `pnpm email:dev` renders, so the dev server still has
 * something to show without the production path having defaults at all.
 */
export function SignInMagicLink({ email, url }: SignInMagicLinkProps) {
  return (
    <Layout preview="Your Rayi sign-in link">
      <Text className="text-[20px] leading-[28px] font-semibold tracking-tight text-[#191919] m-0 mb-3">
        Sign in to Rayi
      </Text>
      <Text className="text-[14px] leading-[22px] text-[#454545] m-0">
        Use the link below to sign in as <strong>{email}</strong>. It works once, and only in the
        browser that requested it.
      </Text>

      <Action href={url} label="Sign in" />

      <Text className="text-[13px] leading-[20px] text-[#454545] mt-7 mb-0">
        If you did not ask to sign in, someone may have typed your address by mistake. Nothing has
        happened to your account, and you do not need to do anything.
      </Text>
    </Layout>
  );
}

SignInMagicLink.PreviewProps = {
  email: 'jordan@acme.com',
  url: 'https://app.rayi.com/auth/magic?token=preview-token-not-real',
} satisfies SignInMagicLinkProps;

export default SignInMagicLink;
