/**
 * The Brevo HTTP API, and nothing above it.
 *
 * Everything provider-shaped lives in this file: the request, the timeout, and
 * the classification of a Brevo error into permanent or retryable. The Channel
 * wrapper next door is the only thing that knows about our own types.
 */

import axios, { AxiosError } from "axios";

import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { isPermanentStatus } from "../types.js";
import {
  renderNotificationEmail,
  type EmailTemplateInput,
} from "./template.js";

export type SendEmailInput = EmailTemplateInput & {
  to: string;
  toName?: string | null;
};

export type SendEmailResult = {
  providerRef?: string;
};

/**
 * A provider error that has already been classified. Carrying the verdict on
 * the error means the channel does not have to re-read HTTP status codes.
 */
export class EmailDeliveryError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, retryable: boolean, status?: number) {
    super(message);
    this.name = "EmailDeliveryError";
    this.retryable = retryable;
    this.status = status;
  }
}

/**
 * The most obviously wrong thing a producer can send. Brevo would reject it
 * with a 400, but checking here saves a network round trip and guarantees we
 * fail fast rather than retry five times on an address that can never work.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isDeliverableAddress(address: string): boolean {
  return EMAIL_SHAPE.test(address.trim());
}

function describeBrevoError(err: unknown): string {
  if (err instanceof AxiosError) {
    const status = err.response?.status;

    // Brevo returns { code, message } and its own error code, which is far
    // more useful in a log than "Request failed with status code 400".
    const data = err.response?.data as { message?: string; code?: string } | undefined;
    const detail = data?.message ?? err.message;

    return status ? `Brevo ${status}: ${detail}` : `Brevo unreachable: ${detail}`;
  }

  return err instanceof Error ? err.message : String(err);
}

export async function sendEmail(
  input: SendEmailInput,
): Promise<SendEmailResult> {
  if (!env.BREVO_API_KEY) {
    // No key is a configuration problem, not a transient one. Retrying will
    // not conjure an API key, so this fails permanently and loudly.
    throw new EmailDeliveryError(
      "BREVO_API_KEY is not set - email cannot be sent",
      false,
    );
  }

  if (!isDeliverableAddress(input.to)) {
    throw new EmailDeliveryError(
      `Refusing to send to an invalid address: ${input.to}`,
      false,
      400,
    );
  }

  const rendered = renderNotificationEmail(input, env.APP_URL);

  logger.debug({ to: input.to, subject: rendered.subject }, "sending email via Brevo");

  try {
    const response = await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender: {
          name: "NotifyHub",
          email: env.EMAIL_FROM,
        },
        to: [
          {
            email: input.to,
            ...(input.toName ? { name: input.toName } : {}),
          },
        ],
        subject: rendered.subject,
        htmlContent: rendered.html,
        textContent: rendered.text,
      },
      {
        headers: {
          accept: "application/json",
          "api-key": env.BREVO_API_KEY,
          "content-type": "application/json",
        },
        timeout: 10_000,
      },
    );

    return {
      providerRef: response.data?.messageId,
    };
  } catch (err) {
    const status = err instanceof AxiosError ? err.response?.status : undefined;

    // No response at all means we never reached Brevo (DNS, TLS, timeout) -
    // that is worth another try. A 429 is Brevo asking us to slow down, which
    // is also worth another try. Everything else follows the shared table.
    const retryable =
      status === undefined || status === 429 || !isPermanentStatus(status);

    throw new EmailDeliveryError(describeBrevoError(err), retryable, status);
  }
}