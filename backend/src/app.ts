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
 */

import express, { type Express } from "express";
import helmet from "helmet";
import cors from "cors";
import { pinoHttp, type Options as PinoHttpOptions } from "pino-http";

import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { healthRouter } from "./api/health.js";
import { requireUser, requireService } from "./middleware/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";

export function createApp(): Express {
  const app = express();

  // Render and most hosts sit behind a proxy. Without this, req.ip is the
  // proxy's address and rate limiting later would throttle everyone as one.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(helmet());

  app.use(
    cors({
      origin: env.APP_URL,
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

  // --- Browser routes: JWT required ---------------------------------------
  // Bell adds notifications and Ember adds preferences under here.
  const api = express.Router();
  api.use(requireUser);

  // Temporary, until the real routes land. Proves the middleware works end
  // to end and gives the frontend something to point at.
  api.get("/me", (req, res) => {
    res.json({ id: req.user!.sub, email: req.user!.email });
  });

  app.use("/api/v1", api);

  // --- Service routes: shared key required --------------------------------
  // The producer endpoint lives here. Never reachable from a browser.
  const internal = express.Router();
  internal.use(requireService);

  internal.get("/ping", (_req, res) => {
    res.json({ status: "ok", scope: "service" });
  });

  app.use("/internal", internal);

  // --- Tail ----------------------------------------------------------------
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
