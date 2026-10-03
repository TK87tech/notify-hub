/**
 * Firebase Cloud Messaging, and nothing above it.
 *
 * Tokens rot. A browser that cleared site data, an uninstalled app or an old
 * registration all produce tokens FCM will reject forever, so this file's job
 * includes telling the caller which tokens are permanently dead, so they can
 * be deleted rather than retried five times.
 */

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

import { env } from "../../config/env.js";

type PushMessage = {
  tokens: string[];
  title: string;
  body?: string | null;
  link?: string | null;
  data?: Record<string, string>;
};

export type PushTokenOutcome = {
  token: string;
  sent: boolean;
  providerRef?: string;
  error?: string;
  /** True when this token will never work again and should be deleted. */
  dead?: boolean;
};

export type PushResult = {
  sentCount: number;
  outcomes: PushTokenOutcome[];
};

/** Provider error codes that mean "stop sending to this token". */
const UNRECOVERABLE = new Set([
  "messaging/invalid-argument",
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/registration-token-opted-out",
  "messaging/invalid-receiver",
  "messaging/registration-token-too-large",
  "messaging/invalid-apns-credentials",
]);

export class PushNotConfiguredError extends Error {
  constructor() {
    super(
      "Push is not configured. Set FCM_PROJECT_ID, FCM_CLIENT_EMAIL and FCM_PRIVATE_KEY",
    );
    this.name = "PushNotConfiguredError";
  }
}

export function isPushConfigured(): boolean {
  return Boolean(env.FCM_PROJECT_ID && env.FCM_CLIENT_EMAIL && env.FCM_PRIVATE_KEY);
}

let cachedApp: ReturnType<typeof initializeApp> | null = null;

function getFirebaseApp() {
  if (cachedApp) return cachedApp;

  const existingApp = getApps()[0];
  if (existingApp) {
    cachedApp = existingApp;
    return cachedApp;
  }

  if (!isPushConfigured()) {
    throw new PushNotConfiguredError();
  }

  // A private key copied out of the Firebase console arrives with literal
  // \n sequences, and the SDK needs real newlines.
  cachedApp = initializeApp({
    credential: cert({
      projectId: env.FCM_PROJECT_ID,
      clientEmail: env.FCM_CLIENT_EMAIL,
      privateKey: env.FCM_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });

  return cachedApp;
}

/** Test seam: drops the cached app so a test can configure a different one. */
export function resetFirebaseAppForTests(): void {
  cachedApp = null;
}

export async function sendPushNotification(message: PushMessage): Promise<PushResult> {
  if (message.tokens.length === 0) {
    return { sentCount: 0, outcomes: [] };
  }

  const messaging = getMessaging(getFirebaseApp());

  const data: Record<string, string> = {
    ...(message.data ?? {}),
    notificationId: String(message.data?.notificationId ?? ""),
  };

  if (message.link) data.link = message.link;

  const response = await messaging.sendEachForMulticast({
    tokens: message.tokens,
    notification: {
      title: message.title,
      ...(message.body ? { body: message.body } : {}),
    },
    data,
    // Without this the click handler has to guess what to open.
    webpush: {
      fcmOptions: { link: message.link ?? undefined },
    },
  });

  const outcomes: PushTokenOutcome[] = response.responses.map((result, index) => {
    const token = message.tokens[index];

    if (result.success) {
      return { token, sent: true, providerRef: result.messageId };
    }

    const code = result.error?.code ?? "unknown";
    const detail = result.error?.message ?? "FCM delivery failed";

    return {
      token,
      sent: false,
      error: `${code}: ${detail}`,
      dead: UNRECOVERABLE.has(code),
    };
  });

  return {
    sentCount: response.successCount,
    outcomes,
  };
}