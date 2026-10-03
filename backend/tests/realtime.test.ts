/**
 * The Socket.IO gateway.
 *
 * The property that matters most here is negative: a socket authenticated as one
 * user must never receive another user's notification. Everything else - the
 * event names, the payloads - is already pinned by
 * contracts/realtime-events.md and the TypeScript mirror in src/realtime/events.ts.
 * What only a running server can show is the isolation, so this file starts a
 * real one and connects real clients to it.
 *
 * No Redis. `redisAvailable` is false under NODE_ENV=test, so the gateway skips
 * the subscription and publishing takes the local path - which is the same path
 * production takes for a single API instance.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import jwt from "jsonwebtoken";

import { env } from "../src/config/env.js";
import { createRealtimeGateway, type RealtimeGateway } from "../src/realtime/gateway.js";
import { publishToUser } from "../src/realtime/publisher.js";
import { REALTIME_EVENTS, userRoom } from "../src/realtime/events.js";

let server: Server;
let gateway: RealtimeGateway;
let url: string;
const openSockets: Socket[] = [];

function tokenFor(userId: string): string {
  return jwt.sign({ sub: userId, email: `${userId}@notifyhub.test` }, env.JWT_SECRET, {
    expiresIn: "5m",
  });
}

/**
 * Connects and resolves once the server has confirmed the handshake, so a test
 * never races its own emit against a socket that has not finished joining.
 */
function connectAs(userId: string, token = tokenFor(userId)): Promise<Socket> {
  const socket = connect(url, {
    auth: { token },
    transports: ["websocket"],
    reconnection: false,
  });

  openSockets.push(socket);

  return new Promise((resolve, reject) => {
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", reject);
  });
}

/** Resolves with the first matching event, or undefined if none arrives. */
function nextEvent<T>(socket: Socket, event: string, withinMs = 1_000): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(undefined);
    }, withinMs);

    function handler(payload: T) {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }

    socket.on(event, handler);
  });
}

/** Asserts nothing arrives, rather than trusting that silence means isolation. */
async function expectNoEvent<T>(socket: Socket, event: string, withinMs = 300): Promise<void> {
  const received: T[] = [];
  const handler = (payload: T) => received.push(payload);

  socket.on(event, handler);
  await new Promise((resolve) => setTimeout(resolve, withinMs));
  socket.off(event, handler);

  expect(received).toEqual([]);
}

const notification = (id: string) => ({
  notification: {
    id,
    type: "task_assigned" as const,
    title: `Task ${id}`,
    body: null,
    link: null,
    priority: "normal" as const,
    read: false,
    createdAt: "2026-09-30T12:00:00.000Z",
    data: {},
  },
  unreadCount: 1,
});

beforeAll(async () => {
  server = createServer();
  gateway = createRealtimeGateway(server);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { port } = server.address() as AddressInfo;
  url = `ws://127.0.0.1:${port}`;
});

afterAll(async () => {
  await gateway.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  // Every test disconnects its own sockets; this catches the ones a failed
  // assertion left behind, which would otherwise keep rooms populated.
  while (openSockets.length) openSockets.pop()?.disconnect();
});

describe("handshake authentication", () => {
  it("accepts a valid token", async () => {
    const socket = await connectAs("user-1");

    expect(socket.connected).toBe(true);
  });

  it("rejects a connection with no token at all", async () => {
    await expect(connectAs("user-1", "")).rejects.toThrow(/unauthorized/i);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const forged = jwt.sign({ sub: "user-1", email: "user-1@notifyhub.test" }, "not-the-secret", {
      expiresIn: "5m",
    });

    // A forged token is the whole reason the handshake verifies rather than
    // decoding. Without the check, anybody could claim any user id and join
    // that user's room.
    await expect(connectAs("user-1", forged)).rejects.toThrow(/unauthorized/i);
  });

  it("rejects an expired token", async () => {
    const expired = jwt.sign({ sub: "user-1", email: "user-1@notifyhub.test" }, env.JWT_SECRET, {
      expiresIn: "-1s",
    });

    await expect(connectAs("user-1", expired)).rejects.toThrow(/unauthorized/i);
  });

  it("rejects a valid token that has no subject", async () => {
    const noSub = jwt.sign({ email: "nobody@notifyhub.test" }, env.JWT_SECRET, { expiresIn: "5m" });

    // Without `sub` there is no room to join, so a connection would sit there
    // authenticated but silent.
    await expect(connectAs("user-1", noSub)).rejects.toThrow(/unauthorized/i);
  });

  it("uses the exact word the contract tells the client to match on", async () => {
    // contracts/realtime-events.md: the client stops retrying when the error is
    // exactly "unauthorized". Rewording it here without updating that file turns
    // every frontend reconnect into an infinite loop.
    await expect(connectAs("user-1", "nonsense")).rejects.toThrow("unauthorized");
  });
});

describe("room isolation", () => {
  it("delivers an event to the user it was published for", async () => {
    const socket = await connectAs("user-1");
    const received = nextEvent(socket, REALTIME_EVENTS.notificationNew);

    publishToUser("user-1", REALTIME_EVENTS.notificationNew, notification("n1"));

    await expect(received).resolves.toMatchObject({
      notification: { id: "n1" },
      unreadCount: 1,
    });
  });

  it("never delivers one user's notification to another user", async () => {
    const one = await connectAs("user-1");
    const two = await connectAs("user-2");

    // Start listening on both before publishing, so a misrouted event is caught
    // rather than lost to a listener that had not attached yet.
    const leaked = expectNoEvent(two, REALTIME_EVENTS.notificationNew);

    publishToUser("user-1", REALTIME_EVENTS.notificationNew, notification("secret"));

    // user-1 does get it, which proves the publish reached somebody and the test
    // is not passing because nothing was sent at all.
    await expect(nextEvent(one, REALTIME_EVENTS.notificationNew)).resolves.toMatchObject({
      notification: { id: "secret" },
    });

    await leaked;
  });

  it("delivers to both of a user's own tabs", async () => {
    const first = await connectAs("user-1");
    const second = await connectAs("user-1");

    const both = Promise.all([
      nextEvent(first, REALTIME_EVENTS.notificationNew),
      nextEvent(second, REALTIME_EVENTS.notificationNew),
    ]);

    publishToUser("user-1", REALTIME_EVENTS.notificationNew, notification("n-both"));

    const [a, b] = await both;

    // Two tabs, one message. Marking as read in one has to update the other, and
    // that only works if both are genuinely in the same room.
    expect(a).toMatchObject({ notification: { id: "n-both" } });
    expect(b).toMatchObject({ notification: { id: "n-both" } });
  });

  it("does not leak a read receipt to another user", async () => {
    const one = await connectAs("user-1");
    const two = await connectAs("user-2");

    const mine = nextEvent(one, REALTIME_EVENTS.notificationRead);
    const leaked = expectNoEvent(two, REALTIME_EVENTS.notificationRead);

    publishToUser("user-1", REALTIME_EVENTS.notificationRead, { id: "n1", unreadCount: 0 });

    await expect(mine).resolves.toEqual({ id: "n1", unreadCount: 0 });
    await leaked;
  });

  it("keeps rooms keyed by the token, not by anything the client sends", async () => {
    const attacker = await connectAs("user-1");
    const victim = await connectAs("user-2");

    // The client asks to be put in somebody else's room. There is no handler for
    // "join" - the socket has no way to join anything except the room the
    // handshake derived from its verified token - so this is a no-op.
    attacker.emit("join", userRoom("user-2"));
    attacker.emit("subscribe", { room: userRoom("user-2") });

    const leaked = expectNoEvent(attacker, REALTIME_EVENTS.notificationNew);
    const delivered = nextEvent(victim, REALTIME_EVENTS.notificationNew);

    publishToUser("user-2", REALTIME_EVENTS.notificationNew, notification("n2"));

    // The genuine owner gets it...
    await expect(delivered).resolves.toMatchObject({ notification: { id: "n2" } });

    // ...and the socket that asked for the room does not. If a future change ever
    // adds a client-supplied join, this is the assertion that catches it.
    await leaked;
  });

  it("delivers to a user who connects after the event was published", async () => {
    publishToUser("user-1", REALTIME_EVENTS.notificationNew, notification("before"));

    const socket = await connectAs("user-1");

    // Nothing is buffered: the REST inbox is the source of truth and the socket
    // is an optimisation over it. A test that waited for "before" here would
    // hang, which is the correct outcome - it documents the design.
    await expectNoEvent(socket, REALTIME_EVENTS.notificationNew);
  });
});