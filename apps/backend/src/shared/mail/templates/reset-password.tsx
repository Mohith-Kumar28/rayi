// ResetPassword.tsx
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

interface ResetPasswordProps {
  email: string;
  url: string;
}

export const ResetPassword = ({
  email = '{{email}}',
  url = '{{url}}',
}: ResetPasswordProps) => {
  return (
    <Html>
      <Head />
      <Preview>Password Reset Request</Preview>
      <Tailwind>
        <Body className="bg-[#f4f4f7] font-sans">
          <Container className="bg-white max-w-xl mx-auto p-6 rounded-lg">
            <Text className="text-xl font-semibold mb-4">Hi {email},</Text>
            <Text className="text-base mb-2">
              We received a request to reset your password.
            </Text>
            <Text className="text-base mb-4">
              Click the button below to proceed to reset it:
            </Text>
            <Button
              href={url}
              className="bg-blue-600 text-white font-bold py-3 px-5 rounded-md no-underline inline-block mb-4"
            >
              Reset Password
            </Button>
            <Text className="text-xs text-gray-500 text-center mt-6">
              If you did not request this, you can safely ignore this email.
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

export default ResetPassword;
