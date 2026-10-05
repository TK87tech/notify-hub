/**
 * Turns this browser into an FCM registration token.
 *
 * The backend sends through Firebase Admin's sendEachForMulticast, which takes
 * FCM registration tokens. A raw PushSubscription endpoint is not one - FCM
 * rejects it as invalid and the backend deletes the device as dead - so the
 * token has to come from the Firebase web SDK.
 *
 * The SDK is imported on demand: it is only needed by the one click that
 * enables push, and it is not small.
 */

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
};

export function isFirebaseConfigured(): boolean {
  return Object.values(config).every(Boolean);
}

/**
 * Subscribes on our own service worker registration rather than letting the
 * SDK register firebase-messaging-sw.js: public/sw.js already handles the push
 * and notificationclick events, and two workers on one scope would fight.
 */
export async function getFcmToken(
  vapidKey: string,
  serviceWorkerRegistration: ServiceWorkerRegistration,
): Promise<string> {
  if (!isFirebaseConfigured()) {
    throw new Error("Push is not configured on this deployment (VITE_FIREBASE_* is missing).");
  }

  const [{ getApps, initializeApp }, { getMessaging, getToken }] = await Promise.all([
    import("firebase/app"),
    import("firebase/messaging"),
  ]);

  const app = getApps()[0] ?? initializeApp(config);

  return getToken(getMessaging(app), { vapidKey, serviceWorkerRegistration });
}
