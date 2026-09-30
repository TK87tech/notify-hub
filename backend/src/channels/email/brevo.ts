import axios from "axios";

import { env } from "../../config/env.js";
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

export async function sendEmail(
  input: SendEmailInput,
): Promise<SendEmailResult> {
  if (!env.BREVO_API_KEY) {
    throw new Error("BREVO_API_KEY is not set - email cannot be sent");
  }

  const rendered = renderNotificationEmail(input);

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
}