import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { lazy, StrictMode, Suspense, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "./components/ui/button";
import { m } from "./paraglide/messages";
import { installCrashDiagnostics } from "./lib/crash-diagnostics";
import { clientReleaseFeatures, loadClientReleaseFeatures } from "./lib/release-features";
import { queryClient } from "./lib/queryClient";
import { routeTree } from "./routeTree.gen";
import "./index.css";

// Surface any crash breadcrumbs from the previous session + monitor heap.
installCrashDiagnostics();

function createAppRouter() {
  return createRouter({ routeTree });
}

function ClientBootstrap() {
  const [router, setRouter] = useState<ReturnType<typeof createAppRouter> | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestInFlight = useRef(false);

  const initialize = async () => {
    if (requestInFlight.current || router) return;
    requestInFlight.current = true;
    setLoading(true);
    setFailed(false);
    try {
      await loadClientReleaseFeatures();
      initGameAdapters(clientReleaseFeatures);
      setRouter(createAppRouter());
    } catch {
      setFailed(true);
    } finally {
      requestInFlight.current = false;
      setLoading(false);
    }
  };

  useEffect(() => {
    void initialize();
  }, []);

  if (!router) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-app-bg p-6 text-app-text">
        <p role={failed ? "alert" : "status"} className={failed ? "text-status-danger" : undefined}>
          {failed ? m.access_unavailable() : m.common_loading()}
        </p>
        {failed && (
          <Button variant="app-outline" size="app-md" onClick={() => void initialize()} disabled={loading}>
            {m.access_retry()}
          </Button>
        )}
      </main>
    );
  }

  return (
    <>
      <RouterProvider router={router} />
      {RaceIqDevtools ? (
        <Suspense fallback={null}>
          <RaceIqDevtools router={router} queryClient={queryClient} />
        </Suspense>
      ) : null}
    </>
  );
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
const RaceIqDevtools = import.meta.env.DEV ? lazy(() => import("./devtools/RaceIqDevtools")) : null;


createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ClientBootstrap />
  </StrictMode>,
);
