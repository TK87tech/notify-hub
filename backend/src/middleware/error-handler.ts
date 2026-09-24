/**
 * The last middleware in the chain. Everything thrown anywhere ends up here
 * and leaves as the contract's Error shape.
 *
 * Express 5 forwards rejected promises from async handlers automatically, so
 * a plain `throw notFound()` inside an async route reaches this function
 * without any try/catch or wrapper.
 */

import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { ApiError, notFound } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { isProduction } from "../config/env.js";

/** Anything that reaches the end of the chain was never routed. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(notFound(`No route for ${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // Already one of ours: send it as-is.
  if (err instanceof ApiError) {
    if (err.status >= 500) logger.error({ err, path: req.path }, err.message);
    else logger.debug({ code: err.code, path: req.path }, err.message);
    res.status(err.status).json(err.toJSON());
    return;
  }

  // Validation failure from a zod schema in a route.
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({
      field: i.path.join(".") || "(root)",
      message: i.message,
    }));
    logger.debug({ details, path: req.path }, "validation failed");
    res.status(400).json({
      error: { code: "bad_request", message: "Invalid request body", details },
    });
    return;
  }

  // Prisma's known failures, mapped to something the frontend can act on.
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2025") {
      res.status(404).json({ error: { code: "not_found", message: "Not found" } });
      return;
    }
    if (err.code === "P2002") {
      res.status(409).json({ error: { code: "conflict", message: "That already exists" } });
      return;
    }
  }

  // Malformed JSON body - express.json() throws this before any route runs.
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({
      error: { code: "bad_request", message: "Request body is not valid JSON" },
    });
    return;
  }

  // Anything else is a bug. Log it in full, tell the caller nothing useful -
  // stack traces in a response body are how internals leak.
  logger.error({ err, path: req.path, method: req.method }, "unhandled error");
  res.status(500).json({
    error: {
      code: "internal",
      message: isProduction
        ? "Something went wrong on our side"
        : err instanceof Error
          ? err.message
          : String(err),
    },
  });
};
