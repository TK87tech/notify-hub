import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
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
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </StrictMode>,
);
