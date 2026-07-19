import { createFileRoute } from "@tanstack/react-router";
import { TestReviewPage } from "../../components/tunes/TestReviewPage";

/** Post-test review page. `laps` is a comma-separated list of lap ids recorded
 *  during the test that just ended. */
export type TuneReviewSearch = { laps?: string };

export const Route = createFileRoute("/acc/tune/$tuningSessionId_/review")({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): TuneReviewSearch => ({
    laps: typeof search.laps === "string" ? search.laps : undefined,
  }),
});

function RouteComponent() {
  const { tuningSessionId } = Route.useParams();
  const { laps } = Route.useSearch();
  const lapIds = (laps ?? "")
    .split(",")
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
  return <TestReviewPage gameId="acc" tuningSessionId={Number(tuningSessionId)} lapIds={lapIds} />;
}
