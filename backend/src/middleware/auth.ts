/**
 * Two ways into this API, and they must never be confused.
 *
 *   requireUser     - a person's browser, carrying a JWT. Used on every
 *                     /api/v1 route the frontend calls.
 *   requireService  - another part of our own system, carrying the shared
 *                     service key. Used only on /internal routes.
 *
 * The producer endpoint is service-only on purpose. If a browser could call
 * it, any user could send themselves - or anyone else - notifications.
 */

import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { unauthorized, forbidden } from "../lib/errors.js";

/** What we put inside a token. Keep it small - it travels on every request. */
export interface TokenPayload {
  /** The user's id. Standard JWT claim name. */
  sub: string;
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireUser. Absent on service routes. */
      user?: TokenPayload;
    }
  }
}

/** Issue a token. Used by the sign-in route and by `npm run token` in dev. */
export function signToken(payload: TokenPayload, expiresIn: string = "7d"): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: expiresIn as jwt.SignOptions["expiresIn"],
  });
}

function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== "bearer") return null;
  return token;
}

/**
 * Verifies the Authorization header and puts the payload on req.user.
 * Every route below /api/v1 uses this.
 */
export const requireUser: RequestHandler = (req, _res, next) => {
  const token = bearerFrom(req.headers.authorization);

  if (!token) {
    throw unauthorized("Missing Authorization header. Send: Bearer <token>");
  }

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as TokenPayload;

    if (!payload.sub) {
      throw unauthorized("Token is missing the sub claim");
    }

    req.user = { sub: payload.sub, email: payload.email };
    next();
  } catch (err) {
    // Say which of the two it is - "expired" tells the frontend to refresh,
    // "invalid" tells it to sign the user out. Anything vaguer and the
    // frontend cannot tell the difference.
    if (err instanceof jwt.TokenExpiredError) {
      throw unauthorized("Token has expired");
    }
    if (err instanceof jwt.JsonWebTokenError) {
      throw unauthorized("Token is not valid");
    }
    throw err;
  }
};

/**
 * Constant-time comparison. A plain === leaks the key one character at a time
 * through how long the comparison takes, which is a real attack on a value
 * this valuable.
 */
function keysMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Guards /internal. Not a user token - a shared secret between our own
 * services, set as SERVICE_KEY on both ends.
 */
export const requireService: RequestHandler = (req, _res, next) => {
  const given = req.header("x-service-key");

  if (!given) {
    throw unauthorized("Missing x-service-key header");
  }

  if (!keysMatch(given, env.SERVICE_KEY)) {
    throw forbidden("Invalid service key");
  }

  next();
};

/**
 * Reads the user id off the request after requireUser has run.
 * Throws rather than returning undefined, so a route that forgot the
 * middleware fails loudly instead of quietly serving the wrong data.
 */
export function currentUserId(req: Express.Request): string {
  if (!req.user?.sub) {
    throw unauthorized("No authenticated user on this request");
  }
  return req.user.sub;
}
