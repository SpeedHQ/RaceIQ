import { createFileRoute } from "@tanstack/react-router";
import { ExperimentWorkspace } from "../../components/tunes/ExperimentWorkspace";

export type TuneView = "overview" | `s${number}`;

/** Inner review state for the embedded detailed dashboard (race session / lap /
 *  sector view). The experiment itself is the path param, not a search. */
export type TuneSearch = {
  session?: number | "live";
  lap?: number;
  view?: TuneView;
};

export const Route = createFileRoute("/ac-evo/experiments/$experimentId")({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): TuneSearch => ({
    session: search.session === "live" ? "live" : search.session != null ? Number(search.session) : undefined,
    lap: search.lap != null ? Number(search.lap) : undefined,
    view: search.view === "overview" || (typeof search.view === "string" && /^s[1-9]\d*$/.test(search.view)) ? (search.view as TuneView) : undefined,
  }),
});

function RouteComponent() {
  const { experimentId } = Route.useParams();
  return <ExperimentWorkspace gameId="ac-evo" experimentId={Number(experimentId)} />;
}
