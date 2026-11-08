import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { OnboardingModal } from "@/components/onboarding/OnboardingModal";
import { dashboardReturnPath } from "@/lib/dashboard-auth";

export const Route = createFileRoute("/onboarding")({
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: dashboardReturnPath(search.redirect),
    welcome: search.welcome === true || search.welcome === "true" ? true : undefined,
  }),
  beforeLoad: ({ context, search }) => {
    if (!context.auth.pending && context.auth.onboardingComplete && !search.welcome) {
      throw redirect({ href: search.redirect });
    }
  },
  component: OnboardingPage,
});

function OnboardingPage() {
  const { auth } = Route.useRouteContext();
  const search = Route.useSearch();
  const router = useRouter();
  return <OnboardingModal initialStep={auth.pending && auth.upgrade ? 1 : 0} onComplete={async () => {
    await router.invalidate();
    const destination = new URL(search.redirect, window.location.origin);
    destination.searchParams.delete("welcome");
    await router.navigate({ href: `${destination.pathname}${destination.search}${destination.hash}` });
  }} />;
}
