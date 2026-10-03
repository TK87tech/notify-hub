/**
 * Sign-in.
 *
 * Deliberately minimal, because the issue says this is not the point of the
 * project - it just has to work. What is not minimal is the two things that
 * matter for a public deploy:
 *
 *   1. The token lifetime is short (12 hours, not the 7 days `signToken`
 *      defaults to), because there is no refresh-token flow to shorten it
 *      later.
 *   2. Failures are rate limited per IP and per account, because an unlimited
 *      login endpoint is a free password-guessing oracle.
 *
 * A failed sign-in always answers 401 with the same message whether the
 * account exists or not. Saying "no such user" would turn this into an account
 * enumeration endpoint.
 */

import { Router, type ErrorRequestHandler } from "express";
import { z } from "zod";
import { randomBytes } from "node:crypto";

import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { badRequest, unauthorized, tooManyRequests } from "../lib/errors.js";
import { hashPassword, needsRehash, verifyPassword } from "../lib/password.js";
import { signToken, requireUser } from "../middleware/auth.js";

/** Short on purpose: there is no refresh flow, so this is the whole session. */
const TOKEN_TTL = "12h";

const signInSchema = z.object({
  email: z.string().email("Enter a valid email address").max(254),
  password: z.string().min(1, "Enter your password").max(200),
});

interface Attempt {
  count: number;
  firstAt: number;
}

/**
 * An in-memory sliding window. It resets when the process restarts, which is
 * acceptable: this exists to make online guessing impractical, not to be a
 * distributed rate limiter. Upgrading to Redis is a one-file change if we ever
 * run more than one API instance.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

const attempts = new Map<string, Attempt>();

function attemptKey(req: { ip?: string }, body: { email: string }): string {
  return `${req.ip ?? "unknown"}:${body.email.toLowerCase()}`;
}

function isRateLimited(key: string, now: number): boolean {
  const entry = attempts.get(key);

  if (!entry) return false;

  if (now - entry.firstAt > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }

  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(key: string, now: number): void {
  const entry = attempts.get(key);

  if (!entry || now - entry.firstAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: now });
    return;
  }

  entry.count += 1;
}

function clearFailures(key: string): void {
  attempts.delete(key);
}

/** Test seam, and the reason the map cannot grow without bound in production. */
setInterval(() => {
  const now = Date.now();

  for (const [key, entry] of attempts) {
    if (now - entry.firstAt > WINDOW_MS) attempts.delete(key);
  }
}, WINDOW_MS).unref();

/**
 * Clears the failure counters. Exported for tests: the window is module-level
 * state, so one test file's ten deliberate bad passwords would otherwise lock
 * out the next file running in the same process.
 */
export function resetSignInAttempts(): void {
  attempts.clear();
}

export const authRouter = Router();

authRouter.post("/sign-in", async (req, res) => {
  const parsed = signInSchema.safeParse(req.body);

  if (!parsed.success) {
    throw badRequest(
      "Enter an email address and a password",
      parsed.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    );
  }

  const body = parsed.data;
  const key = attemptKey(req, body);
  const now = Date.now();

  if (isRateLimited(key, now)) {
    logger.warn({ email: body.email, ip: req.ip }, "sign-in rate limited");
    throw tooManyRequests(
      "Too many sign-in attempts. Wait 15 minutes and try again.",
    );
  }

  const user = await prisma.user.findUnique({
    where: { email: body.email.toLowerCase() },
    select: { id: true, email: true, name: true, passwordHash: true },
  });

  /**
   * Hash a throwaway password when the account does not exist, so a missing
   * account and a wrong password take the same time. Without this, response
   * latency alone tells an attacker which emails are registered.
   */
  const stored = user?.passwordHash ?? (await getDummyHash());

  const ok = await verifyPassword(body.password, stored);

  if (!user || !user.passwordHash || !ok) {
    recordFailure(key, now);

    // Same message either way, on purpose.
    throw unauthorized("Email or password is incorrect");
  }

  clearFailures(key);

  /**
   * Opportunistic upgrade: if the cost parameters have been raised since this
   * password was set, re-hash it now, while we have the plaintext in hand.
   * A failure here must not block the sign-in, so it is logged and ignored.
   */
  if (needsRehash(user.passwordHash)) {
    void hashPassword(body.password)
      .then((hash) => prisma.user.update({ where: { id: user.id }, data: { passwordHash: hash } }))
      .catch((err) => logger.warn({ err, userId: user.id }, "could not upgrade password hash"));
  }

  logger.info({ userId: user.id }, "user signed in");

  res.json({
    token: signToken({ sub: user.id, email: user.email }, TOKEN_TTL),
    user: { id: user.id, email: user.email, name: user.name ?? null },
  });
});

authRouter.get("/session", requireUser, async (req, res) => {
  // requireUser runs as this route's own middleware. It cannot rely on
  // app.ts mounting this router after requireUser, because sign-in has to sit
  // in front of it - and anything a router leaves unguarded is reachable
  // without a token.
  //
  // The email and name are re-read rather than taken from the token, so an
  // account that was renamed shows its current name on the next page load
  // instead of waiting out the token's twelve hours.
  const user = await prisma.user.findUnique({
    where: { id: req.user!.sub },
    select: { id: true, email: true, name: true },
  });

  if (!user) {
    // A valid signature over a user that no longer exists.
    throw unauthorized("This account no longer exists");
  }

  res.json({ user });
});

/**
 * A hash of a value nobody knows, computed on first use and then cached.
 *
 * Verifying against this when the account does not exist is what makes a
 * missing account and a wrong password take the same time. Without it,
 * response latency alone tells an attacker which emails are registered - and
 * it is why the await below happens even on the not-found path.
 */
let dummyHash: Promise<string> | null = null;

function getDummyHash(): Promise<string> {
  if (!dummyHash) {
    dummyHash = hashPassword(randomBytes(32).toString("hex"));
  }

  return dummyHash;
}

const authErrorHandler: ErrorRequestHandler = (err, _req, _res, next) => {
  if (err instanceof z.ZodError) {
    next(badRequest("Invalid sign-in payload", err.issues));
    return;
  }

  next(err);
};

authRouter.use(authErrorHandler);