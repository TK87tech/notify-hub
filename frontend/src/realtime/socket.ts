/**
 * The Socket.IO connection.
 *
 * Returns the socket rather than owning it, so the provider controls the
 * lifecycle and tests can drive the handlers without a real server.
 *
 * The token goes in `auth`, which is what `userIdFromHandshake` reads on the
 * server. Sending it as a query parameter instead would put a live credential
 * into access logs and browser history.
 */

import { io, type Socket } from "socket.io-client";

import { readToken } from "@/api/token";
import type { ClientToServerEvents, ServerToClientEvents } from "./events";

/** Same host as the API; the gateway attaches to the API's HTTP server. */
export const SOCKET_URL =
  (import.meta.env.VITE_SOCKET_URL as string | undefined) ??
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/api\/v1\/?$/, "") ??
  "http://localhost:4000";

export type NotifySocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Socket.IO's own backoff, deliberately left at its defaults.
 *
 * Reconnection is exponential from 1s with jitter, capped at 5s. Hand-rolling
 * the retry loop would be strictly worse: Socket.IO also retries the upgrade
 * handshake, and a custom loop on top ends up double-retrying or giving up
 * while the socket is mid-handshake.
 */
export function connectSocket(): NotifySocket {
  return io(SOCKET_URL, {
    auth: { token: readToken() },
    // Not reconnection in the URL, so a token refreshed between attempts is
    // re-read from the handshake on the next try.
    reconnection: true,
    reconnectionAttempts: Infinity,
    transports: ["websocket", "polling"],
  });
}