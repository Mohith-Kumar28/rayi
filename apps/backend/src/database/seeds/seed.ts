/* eslint-disable no-console */
import { PrismaClient, Role } from '@prisma/client';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { twoFactor, username } from 'better-auth/plugins';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Running seed...');

  console.log('Checking envionment variables...');
  const adminEmail = process.env.APP_ADMIN_EMAIL;
  if (!adminEmail) {
    console.error(
      '❌ APP_ADMIN_EMAIL is not set in the environment variables.',
    );
    process.exit(1);
  }

  const password = process.env.APP_ADMIN_PASSWORD;
  if (!password) {
    console.error(
      '❌ APP_ADMIN_PASSWORD is not set in the environment variables.',
    );
    process.exit(1);
  }

  const auth = betterAuth({
    emailAndPassword: {
      enabled: true,
    },
    plugins: [
      username({
        usernameValidator: () => {
          return true;
        },
      }),
      twoFactor({
        schema: {
          twoFactor: {
            modelName: 'two_factors',
          },
        },
      }),
    ],
    user: {
      fields: {
        name: 'firstName',
        emailVerified: 'isEmailVerified',
      },
    },
    database: prismaAdapter(prisma, {
      provider: 'postgresql',
    }),
  });

  const res = await auth.api.signUpEmail({
    body: {
      email: adminEmail,
      name: 'Admin User',
      username: adminEmail,
      password: password,
    },
  });

  console.log('🌟 User created with success!');

  await prisma.user.update({
    where: { id: res.user.id },
    data: {
      role: Role.Admin,
      isEmailVerified: true,
    },
  });
  console.log('✅ User updated with success!');

  // Delete the session for the user
  console.log('Delete the session for the user...');
  await prisma.session.deleteMany({
    where: {
      userId: res.user.id,
    },
  });

  console.log('✅ User session deleted successfully!');

  console.log('✅ Seed completed successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
