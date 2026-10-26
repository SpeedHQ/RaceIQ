import { createFileRoute, redirect } from "@tanstack/react-router";
import { LoginScreen } from "@/components/security/LoginScreen";
import { dashboardReturnPath } from "@/lib/dashboard-auth";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: dashboardReturnPath(search.redirect),
    discord: search.discord === "complete" ? "complete" as const : undefined,
  }),
  beforeLoad: ({ context, search }) => {
    if (context.auth.authenticated && search.discord !== "complete") throw redirect({ href: search.redirect });
  },
  component: LoginPage,
});

function LoginPage() {
  const search = Route.useSearch();
  return <LoginScreen discordComplete={search.discord === "complete"} returnPath={search.redirect} />;
}
