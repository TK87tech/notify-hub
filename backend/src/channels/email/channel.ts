/**
 * The email Channel.
 *
 * All this does is turn a delivery attempt into a call on the Brevo provider
 * and translate the outcome into the ChannelResult shape. The retry decision
 * has already been made by the provider, so there is nothing to decide here.
 */

import { claimEmailSlot } from "../../lib/email-quota.js";
import {
  failure,
  success,
  type Channel,
  type ChannelContext,
} from "../types.js";
import { EmailDeliveryError, sendEmail } from "./brevo.js";

export const emailChannel: Channel = {
  name: "email",

  async send(ctx: ChannelContext) {
    // Claimed before the provider call, not after: a send Brevo then rejects
    // still spent a request against the daily ceiling.
    //
    // DailyQuotaExceededError is deliberately allowed to escape. It is not a
    // failure of this email, it is a scheduling problem, and the worker parks
    // the job until the UTC day rolls over rather than spending one of the
    // five attempts on it.
    await claimEmailSlot();

    try {
      const result = await sendEmail({
        to: ctx.recipient.email,
        toName: ctx.recipient.name,
        title: ctx.notification.title,
        body: ctx.notification.body,
        link: ctx.notification.link,
      });

      return success({
        ...(result.providerRef ? { providerRef: result.providerRef } : {}),
      });
    } catch (err) {
      if (err instanceof EmailDeliveryError) {
        return failure(err.message, err.retryable);
      }

      // Anything we did not anticipate is treated as retryable. A bug that
      // throws a TypeError should not dead-letter a user's notification on the
      // first try, and five attempts is a cheap ceiling.
      return failure(err instanceof Error ? err.message : String(err), true);
    }
  },
};