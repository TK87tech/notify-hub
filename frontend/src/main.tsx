import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "next-themes";
import "./index.css";
import App from "./App.tsx";
import { TooltipProvider } from "@/components/ui/tooltip";
import { registerServiceWorker } from "./push/register-service-worker.ts";

// Fire and forget on purpose. `DevicesPage` awaits
// `navigator.serviceWorker.ready`, which cannot resolve until a worker has been
// registered, so this has to have happened by the time somebody clicks Enable -
// but nothing about rendering the app waits on it.
void registerServiceWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Outermost on purpose. The dark tokens in `index.css` hang off a `.dark`
        class on `<html>`, and `ThemeProvider` is the only thing that puts it
        there. Without this the `.dark` block was unreachable, so every screen
        rendered light regardless of the OS setting. `attribute="class"` is what
        matches the `@custom-variant dark (&:is(.dark *))` selector. */}
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
