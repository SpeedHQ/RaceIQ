import { initGameAdapters } from "@shared/games/init";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { installCrashDiagnostics } from "./lib/crash-diagnostics";
import { clientReleaseFeatures } from "./lib/release-features";
import { queryClient } from "./lib/queryClient";
import { routeTree } from "./routeTree.gen";
import "./index.css";

// Surface any crash breadcrumbs from the previous session + monitor heap.
installCrashDiagnostics();

initGameAdapters(clientReleaseFeatures);

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
const RaceIqDevtools = import.meta.env.DEV ? lazy(() => import("./devtools/RaceIqDevtools")) : null;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
    {RaceIqDevtools ? <Suspense fallback={null}><RaceIqDevtools router={router} queryClient={queryClient} /></Suspense> : null}
  </StrictMode>,
);
