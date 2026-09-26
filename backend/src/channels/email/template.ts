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

export function renderNotificationEmail(
  input: EmailTemplateInput,
): RenderedEmail {
  const body = input.body ?? "";
  const link = input.link;

  const html = `
    <div>
      <h2>${input.title}</h2>
      <p>${body}</p>
      ${link ? `<p><a href="${link}">View notification</a></p>` : ""}
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