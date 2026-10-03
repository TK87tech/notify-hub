/**
 * The five-type mapping issue #4 asked for.
 *
 * Worth a test even though it is a lookup table, because the table is the
 * contract: a type added to the API without an entry here is a type that renders
 * nothing, and `TYPE_ICON[type]` on a missing key returns undefined rather than
 * throwing, so React would quietly render an empty span.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NOTIFICATION_TYPES } from "@/api/types";
import { NotificationTypeIcon } from "./NotificationTypeIcon";

const EXPECTED: Record<string, string> = {
  task_assigned: "text-status-info",
  payment_received: "text-status-success",
  deadline_warning: "text-status-warning",
  comment: "text-muted-foreground",
  system: "text-foreground",
};

describe("NotificationTypeIcon", () => {
  it.each(NOTIFICATION_TYPES)("gives %s an icon and a colour", (type) => {
    const { container } = render(<NotificationTypeIcon type={type} />);

    const icon = container.querySelector("svg");

    expect(icon).not.toBeNull();
    expect(icon).toHaveClass(EXPECTED[type]);
  });

  it("covers every type the API declares", () => {
    // A type added to the contract without a mapping here would render an empty
    // span, because indexing a missing key returns undefined rather than throwing.
    expect(Object.keys(EXPECTED).sort()).toEqual([...NOTIFICATION_TYPES].sort());
  });

  it("is decorative, so it is not announced", () => {
    // Every row that shows the icon already shows the notification's own title
    // and body; announcing the type again would only repeat context.
    render(<NotificationTypeIcon type="system" />);

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("keeps a caller-supplied class alongside its own", () => {
    const { container } = render(<NotificationTypeIcon type="comment" className="size-8" />);

    const icon = container.querySelector("svg");

    expect(icon).toHaveClass("size-8");
    expect(icon).toHaveClass("text-muted-foreground");
  });
});
