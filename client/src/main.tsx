import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { lazy, StrictMode, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { installCrashDiagnostics } from "./lib/crash-diagnostics";
import { clientReleaseFeatures, loadClientReleaseFeatures } from "./lib/release-features";
import { queryClient } from "./lib/queryClient";
import { routeTree } from "./routeTree.gen";
import "./index.css";

// Surface any crash breadcrumbs from the previous session + monitor heap.
installCrashDiagnostics();

await loadClientReleaseFeatures();
initGameAdapters(clientReleaseFeatures);

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
const RaceIqDevtools = import.meta.env.DEV ? lazy(() => import("./devtools/RaceIqDevtools")) : null;

function DevtoolsGate() {
  const [pathname, setPathname] = useState(router.state.location.pathname);
  useEffect(() => router.subscribe("onResolved", () => setPathname(router.state.location.pathname)), []);
  return RaceIqDevtools && pathname !== "/overlay" && pathname !== "/overlay/" ? (
    <Suspense fallback={null}>
      <RaceIqDevtools router={router} queryClient={queryClient} />
    </Suspense>
  ) : null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
    <DevtoolsGate />
  </StrictMode>,
);
