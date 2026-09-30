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

// Only http(s) links are rendered; anything else (javascript:, data:, junk)
// is dropped rather than put in an href.
export function safeLink(link: string | null | undefined): string | null {
  if (!link) return null;

  try {
    const url = new URL(link);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function renderNotificationEmail(
  input: EmailTemplateInput,
): RenderedEmail {
  const body = input.body ?? "";
  const link = safeLink(input.link);

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
