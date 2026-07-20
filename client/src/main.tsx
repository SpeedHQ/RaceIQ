import { initGameAdapters } from "@shared/games/init";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installCrashDiagnostics } from "./lib/crash-diagnostics";
import { routeTree } from "./routeTree.gen";
import "./index.css";

// Surface any crash breadcrumbs from the previous session + monitor heap.
installCrashDiagnostics();

// Register all game adapters
initGameAdapters();

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
