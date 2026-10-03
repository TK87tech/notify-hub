/**
 * The theme control, and the wiring it depends on.
 *
 * The regression worth guarding here is not the dropdown: it is that `.dark` is a
 * class on `<html>`, and nothing in the app was putting it there. Every screen
 * rendered light regardless of the OS setting, which is invisible in a unit test
 * and obvious to a user. These tests assert the class actually reaches the
 * document.
 */

import { ThemeProvider } from "next-themes";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { ThemeToggle } from "./ThemeToggle";

function renderToggle() {
  return render(
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

afterEach(() => {
  document.documentElement.className = "";
  window.localStorage.clear();
});

describe("ThemeToggle", () => {
  it("reports the current selection in its accessible name", async () => {
    // Icon-only, so the name is the only thing telling a screen reader what the
    // button is.
    renderToggle();

    expect(await screen.findByRole("button", { name: "Theme: System" })).toBeInTheDocument();
  });

  it("offers light, dark and system", async () => {
    const user = userEvent.setup();

    renderToggle();

    await user.click(screen.getByRole("button", { name: /Theme:/ }));

    expect(await screen.findByRole("menuitemradio", { name: "Light" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "Dark" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "System" })).toBeInTheDocument();
  });

  it("puts the dark class on the document when dark is chosen", async () => {
    // The whole point of the provider: `.dark` is what index.css hangs the dark
    // tokens off, so if this does not happen the dark theme is unreachable.
    const user = userEvent.setup();

    renderToggle();

    await user.click(screen.getByRole("button", { name: /Theme:/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Dark" }));

    expect(document.documentElement).toHaveClass("dark");
  });

  it("removes the dark class when light is chosen", async () => {
    const user = userEvent.setup();

    document.documentElement.classList.add("dark");

    render(
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
        <ThemeToggle />
      </ThemeProvider>,
    );

    await user.click(screen.getByRole("button", { name: /Theme:/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Light" }));

    expect(document.documentElement).not.toHaveClass("dark");
  });

  it("keeps saying System when the OS decides, rather than claiming the resolved theme", async () => {
    // matchMedia reports matches: false here, so the resolved theme is light. The
    // control should still show the user's actual choice.
    const user = userEvent.setup();

    renderToggle();

    await user.click(screen.getByRole("button", { name: /Theme:/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: "System" }));

    expect(await screen.findByRole("button", { name: "Theme: System" })).toBeInTheDocument();
    expect(document.documentElement).not.toHaveClass("dark");
  });
});
