/**
 * The Express app, built as a function so tests can create one without
 * starting a server or binding a port.
 *
 * Middleware order matters and is not arbitrary:
 *   1. helmet          security headers, before anything can respond
 *   2. cors            the browser's preflight must pass before auth runs
 *   3. json parser     body available to everything after it
 *   4. request logger  so even rejected requests appear in the log
 *   5. routes
 *   6. notFound        nothing matched
 *   7. errorHandler    always last, four arguments, or Express ignores it
 *
 * Note what is NOT here: the Socket.IO gateway. That attaches to an HTTP
 * server, not to the app, and only in index.ts - so a test can build the whole
 * API without opening a socket or subscribing to Redis.
 */

import express, { type Express } from "express";
import helmet from "helmet";
import cors from "cors";
import { pinoHttp, type Options as PinoHttpOptions } from "pino-http";

import { allowedOrigins } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { healthRouter } from "./api/health.js";
import { authRouter } from "./api/auth.js";
import { notificationApiRouter, internalNotificationRouter } from "./api/notifications.js";
import { preferencesApiRouter } from "./api/preferences.js";
import { operationsRouter, operationsServiceRouter } from "./api/operations.js";

import { requireUser, requireService } from "./middleware/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";

export function createApp(): Express {
  const app = express();

  // Render, Vercel and most hosts sit behind a proxy. Without this, req.ip is
  // the proxy's address and the sign-in rate limiter would throttle every
  // visitor as one.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(helmet());

  app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
      // Both auth headers must be allowed through the preflight, or the
      // browser refuses to send them and every call fails with a CORS error
      // that looks nothing like an auth problem.
      allowedHeaders: ["Content-Type", "Authorization", "x-service-key"],
    }),
  );

  app.use(express.json({ limit: "100kb" }));

  // Declared as its own typed object rather than inline: pino-http infers its
  // custom-levels generic from customLogLevel's return type, and inline it
  // infers a narrower type than our logger has.
  const httpLogOptions: PinoHttpOptions = {
    logger,
    // Health checks every few seconds would drown the log otherwise.
    autoLogging: { ignore: (req) => (req.url ?? "").startsWith("/health") },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
  };
  app.use(pinoHttp(httpLogOptions));

  // --- Public -------------------------------------------------------------
  app.use(healthRouter);

  // --- Browser routes ------------------------------------------------------
  const api = express.Router();

  // Sign-in is the one browser route that cannot need a token, so /auth is
  // mounted ahead of requireUser. The router guards its own protected routes
  // (/auth/session) with requireUser directly - do not "tidy" this by moving
  // the mount below line 90, which would either lock sign-in out or leave
  // /auth/session unguarded.
  api.use("/auth", authRouter);

  // Everything else requires a JWT.
  api.use(requireUser);

  // Temporary, until the real routes land. Proves the middleware works end
  // to end and gives the frontend something to point at.
  api.get("/me", (req, res) => {
    res.json({ id: req.user!.sub, email: req.user!.email });
  });

  api.use(notificationApiRouter);
  api.use(preferencesApiRouter);
  api.use(operationsRouter);
  app.use("/api/v1", api);

  // --- Service routes: shared key required --------------------------------
  // The producer endpoint lives here. Never reachable from a browser.
  const internal = express.Router();
  internal.use(requireService);

  internal.get("/ping", (_req, res) => {
    res.json({ status: "ok", scope: "service" });
  });

  internal.use(internalNotificationRouter);
  internal.use(operationsServiceRouter);
  app.use("/internal", internal);

  // --- Tail ----------------------------------------------------------------
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}