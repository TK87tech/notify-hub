import { Router, type ErrorRequestHandler } from "express";
import { z } from "zod";

import { prisma } from "../lib/prisma.js";
import { badRequest } from "../lib/errors.js";
import { currentUserId } from "../middleware/auth.js";

const notificationTypes = [
  "task_assigned",
  "payment_received",
  "deadline_warning",
  "comment",
  "system",
] as const;

const channelSetSchema = z
  .object({
    inApp: z.boolean(),
    email: z.boolean(),
    push: z.boolean(),
  })
  .strict();

const channelsSchema = z
  .object({
    task_assigned: channelSetSchema,
    payment_received: channelSetSchema,
    deadline_warning: channelSetSchema,
    comment: channelSetSchema,
    system: channelSetSchema,
  })
  .strict();

const timeSchema = z.string().regex(
  /^(?:[01]\d|2[0-3]):[0-5]\d$/,
  "Time must use HH:mm format",
);

const quietHoursSchema = z
  .object({
    start: timeSchema,
    end: timeSchema,
    timezone: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      new Intl.DateTimeFormat("en-US", {
        timeZone: value.timezone,
      }).format();
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["timezone"],
        message: "Timezone must be a valid IANA timezone",
      });
    }
  });

const preferencesBodySchema = z
  .object({
    channels: channelsSchema,
    quietHours: quietHoursSchema.nullable().optional(),
  })
  .strict();

const deviceBodySchema = z
  .object({
    token: z.string().min(1),
    platform: z.enum(["web", "android", "ios"]),
  })
  .strict();

const DEFAULT_CHANNELS = {
  task_assigned: {
    inApp: true,
    email: true,
    push: false,
  },
  payment_received: {
    inApp: true,
    email: true,
    push: true,
  },
  deadline_warning: {
    inApp: true,
    email: false,
    push: true,
  },
  comment: {
    inApp: true,
    email: false,
    push: false,
  },
  system: {
    inApp: true,
    email: true,
    push: false,
  },
} as const;

function isQuietHoursConfigured(
  preference: {
    quietStart: string | null;
    quietEnd: string | null;
    quietTimezone: string | null;
  } | null,
): preference is {
  quietStart: string;
  quietEnd: string;
  quietTimezone: string;
} {
  return Boolean(
    preference?.quietStart &&
      preference.quietEnd &&
      preference.quietTimezone,
  );
}

function buildPreferencesResponse(preference: {
  channels: unknown;
  quietStart: string | null;
  quietEnd: string | null;
  quietTimezone: string | null;
}) {
  const channels =
    preference.channels &&
    typeof preference.channels === "object"
      ? preference.channels
      : DEFAULT_CHANNELS;

  return {
    channels,
    quietHours: isQuietHoursConfigured(preference)
      ? {
          start: preference.quietStart,
          end: preference.quietEnd,
          timezone: preference.quietTimezone,
        }
      : null,
  };
}

export const preferencesApiRouter = Router();

/**
 * GET /preferences
 *
 * Returns saved preferences. If the user has never saved any,
 * sensible defaults are returned without creating a database row.
 */
preferencesApiRouter.get("/preferences", async (req, res) => {
  const userId = currentUserId(req);

  const preference = await prisma.preference.findUnique({
    where: { userId },
  });

  if (!preference) {
    res.json({
      channels: DEFAULT_CHANNELS,
      quietHours: null,
    });
    return;
  }

  res.json(buildPreferencesResponse(preference));
});

/**
 * PUT /preferences
 *
 * Replaces the signed-in user's complete notification preferences.
 */
preferencesApiRouter.put("/preferences", async (req, res) => {
  const userId = currentUserId(req);
  const payload = preferencesBodySchema.parse(req.body);

  const quietStart = payload.quietHours?.start ?? null;
  const quietEnd = payload.quietHours?.end ?? null;
  const quietTimezone = payload.quietHours?.timezone ?? null;

  const preference = await prisma.preference.upsert({
    where: { userId },
    update: {
      channels: payload.channels,
      quietStart,
      quietEnd,
      quietTimezone,
    },
    create: {
      userId,
      channels: payload.channels,
      quietStart,
      quietEnd,
      quietTimezone,
    },
  });

  res.json(buildPreferencesResponse(preference));
});

/**
 * POST /devices
 *
 * Registers a push device. The token is unique, so registering an
 * existing token updates that row instead of creating a duplicate.
 */
preferencesApiRouter.post("/devices", async (req, res) => {
  const userId = currentUserId(req);
  const payload = deviceBodySchema.parse(req.body);

  const device = await prisma.device.upsert({
    where: {
      token: payload.token,
    },
    update: {
      userId,
      platform: payload.platform,
      lastSeen: new Date(),
    },
    create: {
      userId,
      token: payload.token,
      platform: payload.platform,
      lastSeen: new Date(),
    },
  });

  res.status(201).json({
    id: device.id,
    token: device.token,
    platform: device.platform,
    lastSeen: device.lastSeen,
  });
});

const preferencesErrorHandler: ErrorRequestHandler = (
  err,
  _req,
  _res,
  next,
) => {
  if (err instanceof z.ZodError) {
    next(badRequest("Invalid preferences or device payload", err.issues));
    return;
  }

  next(err);
};

preferencesApiRouter.use(preferencesErrorHandler);