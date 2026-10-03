/**
 * Sentry, wrapped so nothing else in the codebase has to know about it.
 *
 * Two rules:
 *
 *   1. With no SENTRY_DSN this is a complete no-op. Sentry must never be a
 *      reason a local run, a test run or a contributor's first `npm install`
 *      behaves differently from production with a DSN set.
 *   2. Every call is wrapped. A monitoring tool that can throw and take the
 *      process down with it is worse than no monitoring tool.
 */

import { logger } from "./logger.js";
import { env } from "../config/env.js";

interface SentryLike {
  init: (options: Record<string, unknown>) => void;
  captureException: (error: unknown, context?: Record<string, unknown>) => void;
  captureMessage: (message: string, context?: Record<string, unknown>) => void;
  close: (timeout: number) => Promise<void>;
}

const enabled = Boolean(env.SENTRY_DSN) && !env.SENTRY_DSN.startsWith("http://localhost");

/**
 * Loaded lazily and only when there is a DSN. An import that pulls in the whole
 * SDK on every `npm test` run is dead weight, and the SDK reads environment
 * variables at import time.
 */
let sentry: SentryLike | null = null;
let loading: Promise<SentryLike | null> | null = null;

async function sdk(): Promise<SentryLike | null> {
  if (!enabled) return null;
  if (sentry) return sentry;

  loading ??= import("@sentry/node")
    .then((mod) => {
      sentry = mod as unknown as SentryLike;

      sentry.init({
        dsn: env.SENTRY_DSN,
        environment: env.NODE_ENV,
        // Logs go to stdout in production, where Render collects them. Sending
        // them to Sentry as well is duplicate cost for the free tier.
        tracesSampleRate: 0,
        // Skip what the error handler has already classified and logged. A
        // user's expired token is not an incident.
        beforeSend(event: {
          exception?: { values?: Array<{ type?: string }> };
        }) {
          const values = event.exception?.values ?? [];

          return values.some((value) => value.type === "ApiError") ? null : (event as never);
        },
      });

      return sentry;
    })
    .catch((err) => {
      logger.warn({ err }, "Sentry SDK could not be loaded; error reporting is off");
      return null;
    });

  return loading;
}

export const Sentry = {
  enabled,

  init(): void {
    if (!enabled) return;
    void sdk();
  },

  captureException(error: unknown, context?: Record<string, unknown>): void {
    if (!enabled) return;

    void sdk().then((client) => {
      try {
        client?.captureException(error, context);
      } catch (err) {
        logger.warn({ err }, "Sentry captureException failed");
      }
    });
  },

  captureMessage(message: string, context?: Record<string, unknown>): void {
    if (!enabled) return;

    void sdk().then((client) => {
      try {
        client?.captureMessage(message, context);
      } catch (err) {
        logger.warn({ err }, "Sentry captureMessage failed");
      }
    });
  },

  async close(timeout = 2_000): Promise<void> {
    if (!sentry) return;

    try {
      await sentry.close(timeout);
    } catch {
      // Shutting down is not the moment to fail over a monitoring SDK.
    }
  },
};