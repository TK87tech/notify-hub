import { Worker } from "bullmq";
import { Redis } from "ioredis";

import { env } from "./config/env.js";
import {
  notificationQueueName,
  type NotificationJobData,
} from "./lib/queue.js";

const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

const worker = new Worker<NotificationJobData>(
  notificationQueueName,
  async (job) => {
    console.log("Processing notification:", {
      jobId: job.id,
      notificationId: job.data.notificationId,
      userId: job.data.userId,
      priority: job.data.priority,
    });

    return {
      notificationId: job.data.notificationId,
      status: "processed",
    };
  },
  {
    connection,
  },
);

worker.on("completed", (job) => {
  console.log(`Notification job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`Notification job ${job?.id ?? "unknown"} failed:`, err);
});

console.log(`Notification worker listening on "${notificationQueueName}"`);