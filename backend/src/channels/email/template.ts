export type EmailTemplateInput = {
  title: string;
  body?: string | null;
  link?: string | null;
};

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
};

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// Notification text can come from user input, so it must never reach the
// HTML as markup.
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/**
 * Only http(s) links are rendered; anything else (javascript:, data:, junk)
 * is dropped rather than put in an href.
 *
 * Notification links are stored relative ("/tasks/91"), so they are resolved
 * against the app URL rather than prefixed by hand - resolving is also what
 * keeps a link to some other host out of the email.
 *
 * A relative link is only accepted when it actually looks like a path. That
 * distinction matters: "not a url" resolves happily against a base into
 * "http://host/not%20a%20url", and an href full of percent-encoded rubbish is
 * worse than no link at all.
 */
export function safeLink(
  link: string | null | undefined,
  baseUrl?: string | null,
): string | null {
  if (!link) return null;

  try {
    const base = baseUrl ?? "http://localhost:5173";
    const url = new URL(link, base);

    // An absolute URL with an exotic scheme - javascript:, data: - is not
    // resolved against the base at all, so it arrives here intact and has to be
    // dropped rather than sanitised.
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(link);
    const looksRelative = /^[/#.]/.test(link);

    if (!isAbsolute && !looksRelative) {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

export function renderNotificationEmail(
  input: EmailTemplateInput,
  baseUrl?: string | null,
): RenderedEmail {
  const body = input.body ?? "";
  const link = safeLink(input.link, baseUrl);

  const html = `
    <div>
      <h2>${escapeHtml(input.title)}</h2>
      <p>${escapeHtml(body)}</p>
      ${link ? `<p><a href="${escapeHtml(link)}">View notification</a></p>` : ""}
    </div>
  `.trim();

  const text = [
    input.title,
    body,
    link ? `View notification: ${link}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    subject: input.title,
    html,
    text,
  };
}
