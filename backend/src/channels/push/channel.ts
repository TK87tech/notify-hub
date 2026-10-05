/**
 * The push Channel.
 *
 * The interesting decision here is what to do about a partial success. FCM
 * takes a batch of tokens and answers per token: some delivered, some
 * permanently broken. The broken ones are deleted from the devices table right
 * away, so the next notification does not carry the same dead weight, and the
 * job's verdict describes only the tokens that were still worth trying.
 */

import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import {
  failure,
  success,
  type Channel,
  type ChannelContext,
} from "../types.js";
import {
  PushNotConfiguredError,
  isPushConfigured,
  sendPushNotification,
} from "./fcm.js";

const PUSH_NOT_CONFIGURED =
  "Push is not configured: FCM_PROJECT_ID, FCM_CLIENT_EMAIL and FCM_PRIVATE_KEY are missing";

let warnedNotConfigured = false;

export const pushChannel: Channel = {
  name: "push",

  async send(ctx: ChannelContext) {
    if (!isPushConfigured()) {
      // A deployment without Firebase is a choice, not a failed delivery.
      // Dead-lettering here filled the DLQ and Sentry with one entry per
      // push-enabled notification. Skipped, with the reason on the
      // delivery_attempts row, and warned once per process so it is not silent.
      if (!warnedNotConfigured) {
        warnedNotConfigured = true;
        logger.warn("push is not configured (FCM_* unset); push deliveries will be skipped");
      }

      return success({ skipped: true, detail: PUSH_NOT_CONFIGURED });
    }

    const devices = await prisma.device.findMany({
      where: { userId: ctx.recipient.id },
      select: { id: true, token: true },
    });

    if (devices.length === 0) {
      return success({ skipped: true, detail: "user has no registered devices" });
    }

    let result;

    try {
      result = await sendPushNotification({
        tokens: devices.map((device) => device.token),
        title: ctx.notification.title,
        body: ctx.notification.body,
        link: ctx.notification.link,
        data: { notificationId: ctx.notification.id },
      });
    } catch (err) {
      if (err instanceof PushNotConfiguredError) {
        return failure(err.message, false);
      }

      return failure(err instanceof Error ? err.message : String(err), true);
    }

    // Delete tokens FCM will never accept again. Doing this before deciding
    // the verdict means a device that has been uninstalled stops costing us
    // requests on every future notification.
    const deadTokenIds = devices
      .filter((device) => result.outcomes.find((o) => o.token === device.token)?.dead)
      .map((device) => device.id);

    if (deadTokenIds.length > 0) {
      try {
        await prisma.device.deleteMany({ where: { id: { in: deadTokenIds } } });
        logger.info(
          { userId: ctx.recipient.id, removed: deadTokenIds.length },
          "removed dead push tokens",
        );
      } catch (err) {
        // Failing to tidy up must not fail the delivery that already worked.
        logger.warn({ err }, "could not remove dead push tokens");
      }
    }

    const firstError = result.outcomes.find((outcome) => !outcome.sent && !outcome.dead)?.error;

    if (result.sentCount > 0) {
      return success({
        providerRef: result.outcomes.find((outcome) => outcome.sent)?.providerRef,
        detail: `${result.sentCount}/${devices.length} devices reached`,
      });
    }

    // Every token either died or failed transiently. Transient failures are
    // retryable; a run where every token was dead is not.
    const allDead = result.outcomes.every((outcome) => outcome.dead);

    return failure(
      firstError ?? "Push reached none of the user's devices",
      !allDead,
    );
  },
};