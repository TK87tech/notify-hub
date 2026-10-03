/**
 * Browser push opt-in. Issue #25.
 *
 * The ordering here is the whole feature and it is easy to get subtly wrong:
 * permission has to be requested *before* a token can exist, and the token has to
 * be registered with the API *before* push is claimed to be working. Every
 * ordering mistake produces the same symptom - the toggle says on and nothing is
 * ever delivered - so the state is derived from what has actually been confirmed
 * rather than from which button was last clicked.
 *
 * Three distinct states are represented, not two: unsupported (no
 * Notification.requestPermission at all), blocked (permission already denied, and
 * the browser will not prompt again), and simply not yet asked.
 */

import { useState } from "react";
import { BellOff, BellRing, Check, Loader2, MonitorSmartphone } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useRegisterDevice } from "@/api/hooks";

type Support = "unsupported" | "supported";

/** VAPID public key, injected at build time. Absent means push is not configured. */
const VAPID_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

export default function DevicesPage() {
  // Derived once, lazily. Push support cannot change between renders, and
  // asking during render would mean a render that is immediately thrown away.
  const [support] = useState<Support>(() =>
    typeof window === "undefined" || !("Notification" in window) ? "unsupported" : "supported",
  );
  const [permission, setPermission] = useState<NotificationPermission | "unknown">(() =>
    typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unknown",
  );
  const [enabled, setEnabled] = useState(false);

  const register = useRegisterDevice();

  if (support === "unsupported") {
    return (
      <section className="space-y-4" aria-labelledby="push-heading">
        <h2 id="push-heading" className="text-lg font-semibold">
          Push notifications
        </h2>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BellOff className="size-4" />

              Not available in this browser
            </CardTitle>

            <CardDescription>
              This browser does not support the Notifications API. You will still receive push
              notifications on mobile, where this app is installed.
            </CardDescription>
          </CardHeader>
        </Card>
      </section>
    );
  }

  const blocked = permission === "denied";

  const enable = async () => {
    if (!VAPID_KEY) {
      toast.error("Push is not configured on this deployment.");
      return;
    }

    try {
      const result = await Notification.requestPermission();

      setPermission(result);

      if (result !== "granted") {
        // Not treated as an error: "denied" is an answer, and telling someone to
        // press the button again when the browser will no longer prompt is
        // worse than saying plainly what happened.
        toast.warning(
          result === "denied"
            ? "Your browser is blocking notifications. Allow them in site settings to enable push."
            : "No decision was recorded, so push was not enabled.",
        );
        return;
      }

      const registration = await navigator.serviceWorker.ready;

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_KEY),
      });

      await register.mutateAsync({
        token: subscription.endpoint,
        platform: detectPlatform(),
      });

      setEnabled(true);
      toast.success("Push notifications enabled");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not enable push notifications. Try again.",
      );
    }
  };

  return (
    <section className="space-y-4" aria-labelledby="push-heading">
      <div>
        <h2 id="push-heading" className="text-lg font-semibold">
          Push notifications
        </h2>

        <p className="text-sm text-muted-foreground">
          Get notified on this device even when the app is closed.
        </p>
      </div>

      <Separator />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MonitorSmartphone className="size-4" />

            This device
          </CardTitle>

          <CardDescription>
            Enabling push registers this browser's subscription with your account, so
            notifications reach you here as well as in the app.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-2 text-sm">
          <p className="flex items-center gap-2">
            {enabled ? (
              <Check className="size-4 text-emerald-600" aria-hidden="true" />
            ) : (
              <BellOff className="size-4 text-muted-foreground" aria-hidden="true" />
            )}

            {enabled
              ? "Push is on for this device."
              : blocked
                ? "Your browser is blocking notifications for this site."
                : "Push is off for this device."}
          </p>

          {!VAPID_KEY && (
            <p className="text-xs text-muted-foreground">
              This deployment has no VITE_VAPID_PUBLIC_KEY configured, so push cannot be enabled
              here.
            </p>
          )}
        </CardContent>

        <CardFooter className="justify-end">
          <Button
            onClick={enable}
            disabled={enabled || blocked || register.isPending || !VAPID_KEY}
            className="gap-1.5"
          >
            {register.isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />

                Enabling…
              </>
            ) : (
              <>
                <BellRing className="size-4" />

                Enable push
              </>
            )}
          </Button>
        </CardFooter>
      </Card>
    </section>
  );
}

/**
 * `applicationServerKey` needs raw bytes, not base64.
 *
 * The explicit `ArrayBuffer` matters: TypeScript 6 will not accept a
 * `Uint8Array<ArrayBufferLike>` here, and a view over a shared buffer is a
 * type error rather than a runtime one.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");

  const raw = atob(normalised);
  const buffer = new ArrayBuffer(raw.length);
  const output = new Uint8Array(buffer);

  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);

  return output;
}

/** Reported to the API so delivery can pick the right FCM options. */
function detectPlatform(): string {
  const ua = navigator.userAgent;

  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Mac/i.test(ua)) return "macos";
  if (/Windows/i.test(ua)) return "windows";
  if (/Linux/i.test(ua)) return "linux";

  return "web";
}