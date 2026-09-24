/**
 * Structured logging.
 *
 * Pretty-printed and readable in development, JSON in production so Render's
 * log viewer and Sentry can parse it.
 */

import pino from "pino";
import { env, isProduction, isTest } from "../config/env.js";

export const logger = pino({
  level: isTest ? "silent" : env.LOG_LEVEL,
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      }),
  /**
   * Never log these, whatever happens. A JWT in a log file is as good as a
   * password, and the service key opens the producer endpoint to anyone.
   */
  redact: {
    paths: [
      "req.headers.authorization",
      'req.headers["x-service-key"]',
      "req.headers.cookie",
      "*.password",
      "*.token",
    ],
    censor: "[redacted]",
  },
});
