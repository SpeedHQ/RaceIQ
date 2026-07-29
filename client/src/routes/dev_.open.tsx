import { createFileRoute, redirect } from "@tanstack/react-router";
import { enableDevOnboardingCompletion, normalizeDevTarget } from "../lib/dev-navigation";

type DevOpenSearch = {
  to: string;
};

export const Route = createFileRoute("/dev_/open")({
  validateSearch: (search: Record<string, unknown>): DevOpenSearch => ({
    to: normalizeDevTarget(search.to),
  }),
  beforeLoad: ({ search }) => {
    if (!import.meta.env.DEV) {
      throw redirect({ to: "/", replace: true });
    }

    enableDevOnboardingCompletion(window.sessionStorage);
    throw redirect({ href: search.to, replace: true });
  },
});
