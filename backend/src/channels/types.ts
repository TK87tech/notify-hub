/**
 * The one interface every delivery channel implements.
 *
 * The reason it exists: adding SMS later has to be one new file plus one line
 * in the registry. It must not mean touching the worker, the queue or the
 * producer. Anything the worker needs to know about a channel - what to call,
 * whether to try again - is on this interface or in the registry, never in a
 * switch statement somewhere in the middle of the pipeline.
 */

import type { Channel as PrismaChannel, Priority } from "@prisma/client";

/** Mirrors the Channel enum in the Prisma schema and the contract. */
export type ChannelName = PrismaChannel;

export const CHANNEL_NAMES: ChannelName[] = ["in_app", "email", "push"];

/** The notification as the channels see it. A plain object, not a Prisma row. */
export interface ChannelNotification {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  priority: Priority;
  data: Record<string, unknown>;
  createdAt: Date;
}

/** Enough of the user to address them. Never the password hash. */
export interface ChannelRecipient {
  id: string;
  email: string;
  name: string | null;
}

/**
 * Everything a channel is allowed to know about the delivery attempt.
 *
 * `attempt` and `attemptCount` are how a channel decides whether it has been
 * given a fair chance - an FCM token that failed four times is a dead token,
 * not a flaky network.
 */
export interface ChannelContext {
  notification: ChannelNotification;
  recipient: ChannelRecipient;
  /** 1 on the first try, 2 on the first retry, and so on. */
  attempt: number;
  /** Total tries allowed for this job, retries included. */
  attemptCount: number;
}

/**
 * A failure, marked retryable or permanent. This distinction is the whole
 * reason channels return a result instead of throwing: a permanent failure
 * (an address that does not exist) must not burn five retries and end up in
 * the dead-letter queue pretending we are still hoping.
 */
export interface ChannelFailure {
  ok: false;
  error: string;
  retryable: boolean;
  /** The provider's own id, when it gives one, so support can trace a message. */
  providerRef?: string;
}

export interface ChannelSuccess {
  ok: true;
  /** True when the channel had nothing to do - push with no devices, say. */
  skipped?: boolean;
  providerRef?: string;
  /** A short note for delivery_attempts, e.g. "3 of 4 tokens failed". */
  detail?: string;
}

export type ChannelResult = ChannelSuccess | ChannelFailure;

export interface Channel {
  readonly name: ChannelName;
  send(ctx: ChannelContext): Promise<ChannelResult>;
}

export const failure = (error: string, retryable: boolean, providerRef?: string): ChannelFailure => ({
  ok: false,
  error,
  retryable,
  ...(providerRef ? { providerRef } : {}),
});

export const success = (opts: Omit<ChannelSuccess, "ok"> = {}): ChannelSuccess => ({ ok: true, ...opts });

/**
 * Heuristic shared by the providers: a 4xx that means "this will never work"
 * is permanent, everything else is worth another try.
 *
 * Permanent: 400 invalid address, 401/403 bad credentials, 404 unknown endpoint,
 * 410 gone, 422 unprocessable. None of those get better by being sent again.
 *
 * Explicitly *not* permanent: 429 rate limited, and anything 408 or 5xx. Those
 * are the provider being busy or unwell rather than the request being wrong, so
 * they are exactly what the backoff and the dead-letter queue are for. Marking
 * 429 permanent would drop messages precisely when the system is under load.
 */
const PERMANENT_STATUS = new Set([400, 401, 402, 403, 404, 405, 410, 422]);

export function isPermanentStatus(status: number): boolean {
  return PERMANENT_STATUS.has(status);
}