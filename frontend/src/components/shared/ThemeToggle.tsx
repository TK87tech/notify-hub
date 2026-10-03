/**
 * Light / Dark / System picker.
 *
 * A radio group rather than a two-state toggle button on purpose: "System" is a
 * real third choice, not a detail. Folding it into a toggle means the control
 * either lies about what is showing or drops the option, and a user who picked
 * "follow my OS" wants that choice to stick after they override it once.
 *
 * The trigger shows the icon of the current *selection*, not the resolved theme,
 * so it keeps saying "System" while the OS is dark instead of quietly claiming
 * the user chose dark.
 */

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type ThemeChoice = "light" | "dark" | "system";

const CHOICES = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const satisfies ReadonlyArray<{ value: ThemeChoice; label: string; icon: typeof Sun }>;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  // `theme` is undefined until next-themes has read storage, and is the string
  // "system" whenever the OS decides. Anything else counts as System, which is
  // also the right thing to show before storage has been read.
  const selected: ThemeChoice = theme === "light" || theme === "dark" ? theme : "system";
  const choice = CHOICES.find((option) => option.value === selected) ?? CHOICES[2];
  const Icon = choice.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon" className="rounded-full" aria-label={`Theme: ${choice.label}`} />
        }
      >
        {/* The radio items below carry the text labels, so the icon is decorative
            here; the button's own accessible name comes from aria-label. */}
        <Icon className="size-4" aria-hidden="true" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-40">
        {/* Radio semantics rather than plain items: a screen reader then announces
            which of the three is currently selected, not just that three exist. */}
        <DropdownMenuRadioGroup
          value={selected}
          onValueChange={(value: ThemeChoice) => setTheme(value)}
        >
          {CHOICES.map((option) => {
            const OptionIcon = option.icon;

            return (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                <OptionIcon />

                {option.label}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
