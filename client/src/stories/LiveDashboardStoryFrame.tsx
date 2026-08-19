import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import { DEFAULT_DISPLAY_SETTINGS } from "../stores/telemetry";
import { ResponsiveWorkspace } from "../components/ResponsiveWorkspace";

interface LiveDashboardStoryFrameProps {
  queryClient: QueryClient;
  story: ComponentType;
}

/**
 * Storybook equivalent of the app shell around live dashboards.
 *
 * Dashboard composition uses the named workspace container, while recorded
 * lap actions require TanStack Router context. Keeping both here prevents
 * standalone stories from silently exercising a different layout contract.
 */
function mockLiveDashboardFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  fallbackFetch: typeof window.fetch,
): Promise<Response> {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const pathname = new URL(url, window.location.origin).pathname;
  if (pathname === "/api/settings") {
    return Promise.resolve(
      new Response(JSON.stringify(DEFAULT_DISPLAY_SETTINGS), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
  if (/^\/api\/acc\/cars\/\d+\/class$/.test(pathname)) {
    return Promise.resolve(
      new Response(JSON.stringify({ class: "GT3" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
  if (pathname === "/api/grip-history") {
    return Promise.resolve(
      new Response(
        JSON.stringify({ fl: [], fr: [], rl: [], rr: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }
  if (pathname === "/api/telemetry-history") {
    const wheels = { fl: [], fr: [], rl: [], rr: [] };
    return Promise.resolve(
      new Response(
        JSON.stringify({
          grip: wheels,
          temp: wheels,
          wear: wheels,
          slipAngle: wheels,
          slipRatio: wheels,
          suspension: wheels,
          throttle: [],
          brake: [],
          speed: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }
  const car = pathname.match(/^\/api\/car-name\/(\d+)$/);
  if (car) {
    return Promise.resolve(new Response(`Demo Car ${car[1]}`, { status: 200 }));
  }
  const track = pathname.match(/^\/api\/track-name\/(\d+)$/);
  if (track) {
    return Promise.resolve(
      new Response(`Demo Track ${track[1]}`, { status: 200 }),
    );
  }
  return fallbackFetch(input, init);
}

function MockLiveDashboardApi({ children }: { children: ReactNode }) {
  useEffect(() => {
    const previousFetch = window.fetch;
    window.fetch = (input, init) =>
      mockLiveDashboardFetch(input, init, previousFetch);
    return () => {
      window.fetch = previousFetch;
    };
  }, []);
  return children;
}
export function LiveDashboardStoryFrame({ queryClient, story: Story }: LiveDashboardStoryFrameProps) {
  const [router] = useState(() => {
    const rootRoute = createRootRoute({ component: Story });
    return createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
  });

  return (
    <MockLiveDashboardApi>
      <QueryClientProvider client={queryClient}>
        <div className="h-screen bg-app-bg text-app-text">
          <ResponsiveWorkspace>
            <RouterProvider router={router} />
          </ResponsiveWorkspace>
        </div>
      </QueryClientProvider>
    </MockLiveDashboardApi>
  );
}
