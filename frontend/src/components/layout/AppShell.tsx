import { NotificationIcon } from "@/components/shared/NotificationIcon";
import type { ReactNode } from "react";
import { LayoutDashboard, Bell, Settings } from "lucide-react";
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

interface AppShellProps {
  children: ReactNode;
}

const navigationItems = [
  {
    label: "Dashboard",
    icon: LayoutDashboard,
    active: true,
  },
  {
    label: "Notifications",
    icon: Bell,
  },
  {
    label: "Settings",
    icon: Settings,
  },
];

export function AppShell({ children }: AppShellProps) {
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader className="border-b px-4 py-4">
          <h1 className="text-xl font-bold">Notify Hub</h1>
          <p className="text-xs text-muted-foreground">
            Notification Management
          </p>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Menu</SidebarGroupLabel>

            <SidebarGroupContent>
              <SidebarMenu>
                {navigationItems.map((item) => {
                  const Icon = item.icon;

                  return (
                    <SidebarMenuItem key={item.label}>
                      <SidebarMenuButton isActive={item.active}>
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

            <div>
              <h2 className="text-lg font-semibold">Dashboard</h2>
              <p className="text-xs text-muted-foreground">Overview</p>
            </div>
          </div>

          <NotificationIcon />
        </header>

        <main className="p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
