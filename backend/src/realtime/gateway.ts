/**
 * The Socket.IO gateway.
 *
 * Rules, straight from contracts/realtime-events.md:
 *
 *   - The JWT is verified in the handshake, not in a per-message handler, so a
 *     bad token never gets a room.
 *   - Every connection joins `user:<userId>` and nothing else. There is no way
 *     for a client to ask to join a room it does not own.
 *   - A rejected handshake fails with the message "unauthorized", which is the
 *     exact string the frontend matches on to stop retrying.
 *   - The socket is one-directional. Marking as read goes through REST and the
 *     result is broadcast back, so there is one code path for that logic.
 *
 * This file attaches to an existing HTTP server rather than creating one, so
 * the API keeps a single port and a single CORS configuration.
 */

import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";

import { allowedOrigins, env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { redisAvailable, subscriber } from "../lib/redis.js";
import {
  REALTIME_REDIS_CHANNEL,
  userRoom,
  type ClientToServerEvents,
  type InterServerEvents,
  type RealtimeEnvelope,
  type ServerToClientEvents,
  type SocketData,
} from "./events.js";
import { originId, registerLocalEmitter } from "./publisher.js";

/** The four generics are Socket.IO's: client events, server events, both ways, socket data. */
type NotifyServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export interface RealtimeGateway {
  io: NotifyServer;
  /** Resolves once every client has disconnected. Safe to call twice. */
  close: () => Promise<void>;
}

/**
 * Socket.IO's own verifier. jwt.verify throws for anything wrong with a token,
 * and every one of those throws is an unauthorized handshake as far as the
 * client is concerned - the token is the only thing we have to go on.
 */
function userIdFromHandshake(handshake: {
  auth?: Record<string, unknown>;
  headers: Record<string, unknown>;
}): string | null {
  const auth = handshake.auth as { token?: unknown } | undefined;
  let token = typeof auth?.token === "string" ? auth.token : null;

  // Polling transports cannot always set auth on the first request, so fall
  // back to a query parameter. Both are in the contract's example.
  if (!token && typeof handshake.headers?.authorization === "string") {
    const [, value] = handshake.headers.authorization.split(" ");
    token = value ?? null;
  }

  if (!token) return null;

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as { sub?: string };
    return payload.sub ?? null;
  } catch (err) {
    logger.debug(
      { reason: err instanceof Error ? err.message : "invalid token" },
      "rejected socket handshake",
    );
    return null;
  }
}

export function createRealtimeGateway(httpServer: HttpServer): RealtimeGateway {
  const io: NotifyServer = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, {
    // Same origins as CORS. Without this Socket.IO answers preflight itself
    // and a Vercel-hosted frontend gets a CORS error that looks like an auth
    // problem.
    cors: {
      origin: allowedOrigins,
      credentials: true,
      methods: ["GET", "POST"],
    },
    // Long enough to survive a brief Render free-tier sleep, short enough
    // that a dropped connection is noticed and the client catches up.
    pingInterval: 25_000,
    pingTimeout: 20_000,
    connectionStateRecovery: {
      maxDisconnectionDuration: 120_000,
      skipMiddlewares: false,
    },
  });

  io.use((socket, next) => {
    const userId = userIdFromHandshake(socket.handshake);

    if (!userId) {
      // The exact string contracts/realtime-events.md tells the client to
      // match on. Do not reword it without updating that file.
      next(new Error("unauthorized"));
      return;
    }

    socket.data.userId = userId;
    next();
  });

  io.on("connection", (socket) => {
    const userId = socket.data.userId;

    void socket.join(userRoom(userId));

    logger.debug({ userId, socketId: socket.id }, "socket connected");

    socket.on("disconnect", (reason) => {
      logger.debug({ userId, socketId: socket.id, reason }, "socket disconnected");
    });
  });

  /** One place that turns an envelope into an emit, used by both paths. */
  function deliver(envelope: RealtimeEnvelope): void {
    io.to(userRoom(envelope.userId)).emit(
      envelope.event as "notification:new",
      envelope.payload as never,
    );
  }

  /**
   * Deliver events published by this process straight to our own sockets, and
   * events published by any other process over Redis.
   */
  const unregisterLocal = registerLocalEmitter(deliver);

  /**
   * Fan out events published by any process - the worker, or this API when a
   * REST call marks a notification read.
   */
  const startSubscription = async () => {
    if (!redisAvailable) return;

    try {
      const client = subscriber();

      if (client.status === "wait") await client.connect();

      await client.subscribe(REALTIME_REDIS_CHANNEL);

      client.on("message", (channel, raw) => {
        if (channel !== REALTIME_REDIS_CHANNEL) return;

        let envelope: RealtimeEnvelope;

        try {
          envelope = JSON.parse(raw) as RealtimeEnvelope;
        } catch (err) {
          logger.warn({ err }, "discarding malformed realtime envelope");
          return;
        }

        // This process already delivered locally when it published. Without
        // this check every read-broadcast would double-fire.
        if (envelope.originId === originId) return;

        deliver(envelope);
      });

      logger.info("subscribed to the realtime event channel");
    } catch (err) {
      logger.error({ err }, "could not subscribe to realtime events");
    }
  };

  void startSubscription();

  let closed = false;

  return {
    io,

    close: async () => {
      if (closed) return;
      closed = true;

      unregisterLocal();

      // Closing the socket server stops it handling upgrades, but not the
      // Redis subscriber, which is a separate client that would keep the
      // event loop alive and stop the process exiting on SIGTERM.
      const client = redisAvailable ? subscriber() : null;

      await new Promise<void>((resolve) => {
        io.close(() => resolve());

        // Don't let a client that will not close hold up the deploy.
        setTimeout(resolve, 5_000).unref();
      });

      if (client) {
        await client.unsubscribe(REALTIME_REDIS_CHANNEL).catch(() => undefined);
        await client.quit().catch(() => client.disconnect());
      }
    },
  };
}