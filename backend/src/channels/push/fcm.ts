import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

type PushMessage = {
  tokens: string[];
  title: string;
  body?: string | null;
  data?: Record<string, string>;
};

type PushResult = {
  successCount: number;
  failureCount: number;
  responses: Array<{
    token: string;
    success: boolean;
    providerRef?: string;
    error?: string;
  }>;
};

function getFirebaseApp() {
  const existingApp = getApps()[0];

  if (existingApp) {
    return existingApp;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Firebase configuration is missing: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY are required",
    );
  }

  return initializeApp({
    credential: cert({
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, "\n"),
    }),
  });
}

export async function sendPushNotification(message: PushMessage): Promise<PushResult> {
  if (message.tokens.length === 0) {
    return {
      successCount: 0,
      failureCount: 0,
      responses: [],
    };
  }

  const app = getFirebaseApp();
  const messaging = getMessaging(app);

  const response = await messaging.sendEachForMulticast({
    tokens: message.tokens,
    notification: {
      title: message.title,
      ...(message.body ? { body: message.body } : {}),
    },
    ...(message.data ? { data: message.data } : {}),
  });

  return {
    successCount: response.successCount,
    failureCount: response.failureCount,
    responses: response.responses.map((result, index) => ({
      token: message.tokens[index],
      success: result.success,
      ...(result.success
        ? { providerRef: result.messageId }
        : { error: result.error?.message ?? "FCM delivery failed" }),
    })),
  };
}
