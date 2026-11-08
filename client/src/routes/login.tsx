import { createFileRoute, redirect } from "@tanstack/react-router";
import { LoginScreen } from "@/components/security/LoginScreen";
import { dashboardReturnPath } from "@/lib/dashboard-auth";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({ redirect: dashboardReturnPath(search.redirect) }),
  beforeLoad: ({ context, search }) => {
    if (context.auth.authenticated) throw redirect({ href: search.redirect });
  },
  component: LoginScreen,
});
