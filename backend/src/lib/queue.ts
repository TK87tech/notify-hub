import { Queue } from "bullmq";
import { Redis } from "ioredis";

import { env } from "../config/env.js";

export const notificationQueueName = "notifications";

const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const notificationQueue = new Queue(notificationQueueName, {
  connection,
});

export interface NotificationJobData {
  notificationId: string;
  userId: string;
  priority: "urgent" | "normal" | "low";
}

export async function enqueueNotification(
  data: NotificationJobData,
  delay = 0,
) {
  return notificationQueue.add("deliver-notification", data, {
    delay,
    removeOnComplete: 100,
    removeOnFail: 100,
  });
}