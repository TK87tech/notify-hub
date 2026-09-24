/**
 * Prints a JWT for a seeded user, so you can call the API from curl, Postman
 * or the frontend before the sign-in route exists.
 *
 *   npm run token                      # the first seeded user
 *   npm run token -- ada@notifyhub.test
 *
 * Development only. Never run this against a production database.
 */

import { prisma } from "../src/lib/prisma.js";
import { signToken } from "../src/middleware/auth.js";
import { env } from "../src/config/env.js";

const email = process.argv[2];

async function main() {
  if (env.NODE_ENV === "production") {
    console.error("Refusing to mint a token in production.");
    process.exit(1);
  }

  const user = email
    ? await prisma.user.findUnique({ where: { email } })
    : await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });

  if (!user) {
    console.error(
      email
        ? `No user with email ${email}. Run: npm run db:seed`
        : "No users found. Run: npm run db:seed",
    );
    process.exit(1);
  }

  const token = signToken({ sub: user.id, email: user.email });

  console.log(`\nUser:  ${user.email}  (${user.id})`);
  console.log(`\nToken:\n${token}`);
  console.log(`\nTry it:\n  curl -H "Authorization: Bearer ${token}" http://localhost:${env.PORT}/api/v1/me\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
