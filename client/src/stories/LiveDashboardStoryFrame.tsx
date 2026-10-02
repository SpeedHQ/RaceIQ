import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { type ComponentType, useState } from "react";
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
export function LiveDashboardStoryFrame({ queryClient, story: Story }: LiveDashboardStoryFrameProps) {
  const [router] = useState(() => {
    const rootRoute = createRootRoute({ component: Story });
    return createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
  });

  return (
    <QueryClientProvider client={queryClient}>
      <div className="h-screen bg-app-bg text-app-text">
        <ResponsiveWorkspace>
          <RouterProvider router={router} />
        </ResponsiveWorkspace>
      </div>
    </QueryClientProvider>
  );
}
