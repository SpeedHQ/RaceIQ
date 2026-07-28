import { createFileRoute } from "@tanstack/react-router";
import { ExperimentWorkspace } from "../../components/tunes/ExperimentWorkspace";

export type TuneView = "overview" | "s1" | "s2" | "s3";
const VIEWS: TuneView[] = ["overview", "s1", "s2", "s3"];

/** Inner review state for the embedded detailed dashboard (race session / lap /
 *  sector view). The experiment itself is the path param, not a search. */
export type TuneSearch = {
  session?: number | "live";
  lap?: number;
  view?: TuneView;
};

export const Route = createFileRoute("/f125/experiments/$experimentId")({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): TuneSearch => ({
    session: search.session === "live" ? "live" : search.session != null ? Number(search.session) : undefined,
    lap: search.lap != null ? Number(search.lap) : undefined,
    view: VIEWS.includes(search.view as TuneView) ? (search.view as TuneView) : undefined,
  }),
});

function RouteComponent() {
  const { experimentId } = Route.useParams();
  return <ExperimentWorkspace gameId="f1-2025" experimentId={Number(experimentId)} />;
}
