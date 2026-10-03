/**
 * Publishing realtime events across processes.
 *
 * The API owns the Socket.IO connections; the worker produces the events. They
 * are different processes - that is the whole point of running the worker
 * separately - so the only thing they share is Redis. This module is the seam.
 *
 *   worker ──publish──▶ Redis pub/sub ──▶ every API instance ──▶ user room
 *
 * Two delivery paths, and both run:
 *
 *   1. Local. If this process has sockets attached, emit immediately. Fast -
 *      no broker hop - and it still works when Redis is briefly down.
 *   2. Remote. Publish to Redis. Every instance receives it, including this
 *      one, which is why the envelope carries an originId and the subscriber
 *      ignores its own.
 *
 * When Redis is unavailable (tests, a local run without Docker) path 1 still
 * works and path 2 is skipped. Losing a push is bad; refusing to send an email
 * because the websocket fan-out is down is worse.
 */

import { randomUUID } from "node:crypto";

import { logger } from "../lib/logger.js";
import { publisher, redisAvailable } from "../lib/redis.js";
import {
  REALTIME_REDIS_CHANNEL,
  type RealtimeEnvelope,
  type RealtimeEvent,
} from "./events.js";

/** Identifies this process, so it can ignore events it published itself. */
export const originId = randomUUID();

type LocalEmitter = (envelope: RealtimeEnvelope) => void;

const localEmitters = new Set<LocalEmitter>();

/**
 * Called by the gateway when it attaches to an HTTP server. Returns an
 * unregister function so a closed gateway stops receiving events - important
 * in tests, where a stale emitter would emit into a server nobody holds.
 */
export function registerLocalEmitter(emitter: LocalEmitter): () => void {
  localEmitters.add(emitter);
  return () => localEmitters.delete(emitter);
}

export function publishToUser(
  userId: string,
  event: RealtimeEvent,
  payload: unknown,
): void {
  const envelope: RealtimeEnvelope = { userId, event, payload, originId };

  for (const emit of localEmitters) {
    try {
      emit(envelope);
    } catch (err) {
      logger.error({ err, userId, event }, "local realtime delivery failed");
    }
  }

  if (!redisAvailable) return;

  void forwardToRedis(envelope);
}

async function forwardToRedis(envelope: RealtimeEnvelope): Promise<void> {
  try {
    const client = publisher();

    if (client.status === "wait") await client.connect();

    await client.publish(REALTIME_REDIS_CHANNEL, JSON.stringify(envelope));
  } catch (err) {
    // Swallowed on purpose. The database row is already written, so the user
    // still sees the notification on their next page load or on reconnect -
    // the socket is an optimisation over the REST API, not the source of truth.
    logger.error({ err, event: envelope.event }, "failed to publish realtime event");
  }
}