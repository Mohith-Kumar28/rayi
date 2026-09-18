// SignInMagicLink.tsx
import {
  Body,
  Button,
  Container,
  Head,
  Html,
  Preview,
  Tailwind,
  Text,
} from '@react-email/components';
import * as React from 'react';

interface SignInMagicLinkProps {
  email: string;
  url: string;
}

export const SignInMagicLink = ({
  email = '{{email}}',
  url = '{{url}}',
}: SignInMagicLinkProps) => {
  return (
    <Html>
      <Head />
      <Preview>Sign in to your account</Preview>
      <Tailwind>
        <Body className="bg-[#f4f4f7] font-sans">
          <Container className="bg-white max-w-xl mx-auto p-6 rounded-lg">
            <Text className="text-xl font-semibold mb-4">Hi {email},</Text>
            <Text className="text-base mb-2">
              You requested to sign in using a magic link.
            </Text>
            <Text className="text-base mb-4">
              Click the button below to access your account:
            </Text>
            <Button
              href={url}
              className="bg-blue-600 text-white font-bold py-3 px-5 rounded-md no-underline inline-block mb-4"
            >
              Sign in
            </Button>
            <Text className="text-base mt-4">
              If you did not request this email, you can safely ignore this
              email.
            </Text>
            <Text className="text-xs text-gray-500 text-center mt-6">
              This link will expire shortly for security reasons.
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
};

export default SignInMagicLink;
