/**
 * Channel name to implementation.
 *
 * This is the only place that knows which class serves which channel. The
 * worker asks for a channel by name and either gets one or gets an error -
 * there is no switch statement anywhere in the delivery path, so adding SMS is
 * this file plus one new folder.
 */

import { emailChannel } from "./email/channel.js";
import { inAppChannel } from "./in-app/in-app.js";
import { pushChannel } from "./push/channel.js";
import { failure, type Channel, type ChannelName } from "./types.js";

const registry: Record<ChannelName, Channel> = {
  in_app: inAppChannel,
  email: emailChannel,
  push: pushChannel,
};

export function getChannel(name: ChannelName): Channel | undefined {
  return registry[name];
}

/**
 * Called by the worker. An unknown channel is a deployment mistake - a job
 * referencing a channel that no longer exists - so it returns a permanent
 * failure rather than throwing, and the attempt is recorded so it is visible.
 */
export async function sendOnChannel(
  name: ChannelName,
  ctx: Parameters<Channel["send"]>[0],
): ReturnType<Channel["send"]> {
  const channel = getChannel(name);

  if (!channel) {
    return failure(`No channel implementation registered for "${name}"`, false);
  }

  return channel.send(ctx);
}

export const registeredChannels = (): Channel[] => Object.values(registry);