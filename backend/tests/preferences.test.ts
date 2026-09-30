import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    preference: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    device: {
      upsert: vi.fn(),
    },
  },
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/lib/queue.js", () => ({
  enqueueNotification: vi.fn(),
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireUser: (req: any, _res: any, next: any) => {
    req.user = {
      sub: "user-1",
      email: "test@example.com",
    };
    next();
  },
  requireService: (_req: any, _res: any, next: any) => {
    next();
  },
  currentUserId: (req: any) => req.user.sub,
}));

import { createApp } from "../src/app.js";

const app = createApp();

const validChannels = {
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
};

describe("preferences and devices API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns sensible defaults when the user has no saved preferences", async () => {
    prismaMock.preference.findUnique.mockResolvedValue(null);

    const response = await request(app)
      .get("/api/v1/preferences");

    expect(response.status).toBe(200);

    expect(response.body).toEqual({
      channels: {
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
      },
      quietHours: null,
    });
  });

  it("saves valid preferences and quiet hours", async () => {
    prismaMock.preference.upsert.mockResolvedValue({
      channels: validChannels,
      quietStart: "22:00",
      quietEnd: "07:00",
      quietTimezone: "Africa/Lagos",
    });

    const response = await request(app)
      .put("/api/v1/preferences")
      .send({
        channels: validChannels,
        quietHours: {
          start: "22:00",
          end: "07:00",
          timezone: "Africa/Lagos",
        },
      });

    expect(response.status).toBe(200);

    expect(response.body.quietHours).toEqual({
      start: "22:00",
      end: "07:00",
      timezone: "Africa/Lagos",
    });

    expect(prismaMock.preference.upsert).toHaveBeenCalled();
  });

  it("rejects an invalid channel type", async () => {
    const invalidChannels = {
      ...validChannels,
      comment: {
        inApp: "yes",
        email: false,
        push: false,
      },
    };

    const response = await request(app)
      .put("/api/v1/preferences")
      .send({
        channels: invalidChannels,
      });

    expect(response.status).toBe(400);
    expect(prismaMock.preference.upsert).not.toHaveBeenCalled();
  });

  it("rejects an unknown notification type", async () => {
    const invalidChannels = {
      ...validChannels,
      unknown_type: {
        inApp: true,
        email: true,
        push: true,
      },
    };

    const response = await request(app)
      .put("/api/v1/preferences")
      .send({
        channels: invalidChannels,
      });

    expect(response.status).toBe(400);
    expect(prismaMock.preference.upsert).not.toHaveBeenCalled();
  });

  it("rejects an invalid quiet-hours timezone", async () => {
    const response = await request(app)
      .put("/api/v1/preferences")
      .send({
        channels: validChannels,
        quietHours: {
          start: "22:00",
          end: "07:00",
          timezone: "Not/A_Timezone",
        },
      });

    expect(response.status).toBe(400);
    expect(prismaMock.preference.upsert).not.toHaveBeenCalled();
  });

  it("registers a device", async () => {
    const device = {
      id: "device-1",
      token: "push-token-123",
      platform: "android",
      lastSeen: new Date("2026-09-30T10:00:00.000Z"),
    };

    prismaMock.device.upsert.mockResolvedValue(device);

    const response = await request(app)
      .post("/api/v1/devices")
      .send({
        token: "push-token-123",
        platform: "android",
      });

    expect(response.status).toBe(201);
    expect(response.body.id).toBe("device-1");
    expect(response.body.token).toBe("push-token-123");
    expect(response.body.platform).toBe("android");
    expect(prismaMock.device.upsert).toHaveBeenCalled();
  });

  it("updates an existing device when the same token is registered again", async () => {
    const device = {
      id: "device-existing",
      token: "same-token",
      platform: "ios",
      lastSeen: new Date("2026-09-30T11:00:00.000Z"),
    };

    prismaMock.device.upsert.mockResolvedValue(device);

    const response = await request(app)
      .post("/api/v1/devices")
      .send({
        token: "same-token",
        platform: "ios",
      });

    expect(response.status).toBe(201);
    expect(response.body.id).toBe("device-existing");
    expect(response.body.token).toBe("same-token");
    expect(response.body.platform).toBe("ios");

    expect(prismaMock.device.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          token: "same-token",
        },
        update: expect.objectContaining({
          userId: "user-1",
          platform: "ios",
        }),
      }),
    );
  });
});