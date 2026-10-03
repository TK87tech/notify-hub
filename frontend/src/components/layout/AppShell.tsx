import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Bell, LayoutDashboard, LogOut, Settings, Smartphone } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NotificationBell } from "@/features/notifications/NotificationBell";
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { useAuth } from "@/auth/auth-context";

interface AppShellProps {
  children: ReactNode;
}

/**
 * `to` rather than a hardcoded `active` flag.
 *
 * The original template shipped `active: true` on one item forever, which is
 * fine for a static mockup and wrong for every page but the first. NavLink
 * derives it from the URL, so highlighting cannot drift out of sync with the
 * route.
 */
const navigationItems = [
  { label: "Notifications", to: "/", icon: LayoutDashboard },
  { label: "Preferences", to: "/preferences", icon: Settings },
  { label: "Devices", to: "/devices", icon: Smartphone },
];

export function AppShell({ children }: AppShellProps) {
  const { user, signOut } = useAuth();

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader className="border-b px-4 py-4">
          <h1 className="text-xl font-bold">Notify Hub</h1>

          <p className="text-xs text-muted-foreground">Notification Management</p>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Menu</SidebarGroupLabel>

            <SidebarGroupContent>
              <SidebarMenu>
                {navigationItems.map((item) => {
                  const Icon = item.icon;

                  return (
                    <SidebarMenuItem key={item.to}>
                      {/* `render` is the Base UI composition primitive here -
                          this UI kit is @base-ui/react, not Radix, so `asChild`
                          does not exist. NavLink renders the button element and
                          supplies its own active styling from the URL, which is
                          why nothing hardcodes `active`. */}
                      <SidebarMenuButton
                        render={
                          <NavLink
                            to={item.to}
                            className={({ isActive }) =>
                              isActive ? "bg-sidebar-accent font-medium" : undefined
                            }
                          />
                        }
                      >
                        <Icon />

                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>

      <SidebarInset>
        <header className="flex h-16 items-center justify-between border-b px-6">
          <div className="flex items-center gap-4">
            <SidebarTrigger />
          </div>

          <div className="flex items-center gap-2">
            <NotificationBell />

            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="rounded-full"
                    aria-label="Account menu"
                  />
                }
              >
                <Avatar className="size-8">
                  <AvatarFallback>{initials(user?.email)}</AvatarFallback>
                </Avatar>
              </DropdownMenuTrigger>

              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="truncate">{user?.email ?? "Signed in"}</DropdownMenuLabel>

                <DropdownMenuSeparator />

                <DropdownMenuItem render={<NavLink to="/preferences" />}>
                  <Settings />

                  Preferences
                </DropdownMenuItem>

                <DropdownMenuItem render={<NavLink to="/devices" />}>
                  <Bell />

                  Devices and push
                </DropdownMenuItem>

                <DropdownMenuSeparator />

                {/* Sign-out clears the cached session, so leaving the page
                    without this would strand the next user on a shared
                    machine. */}
                <DropdownMenuItem variant="destructive" onSelect={() => signOut()}>
                  <LogOut />

                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}

/** Two letters from the local part, so the fallback is never a full address. */
function initials(email: string | undefined): string {
  if (!email) return "?";

  const [local] = email.split("@");

  return (local.slice(0, 2) || "?").toUpperCase();
}