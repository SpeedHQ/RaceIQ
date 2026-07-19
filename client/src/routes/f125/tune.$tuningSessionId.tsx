import { createFileRoute } from "@tanstack/react-router";
import { TuningSessionWorkspace } from "../../components/tunes/TuningSessionWorkspace";

export type TuneView = "overview" | "s1" | "s2" | "s3";
const VIEWS: TuneView[] = ["overview", "s1", "s2", "s3"];

/** Inner review state for the embedded detailed dashboard (race session / lap /
 *  sector view). The tuning session itself is the path param, not a search. */
export type TuneSearch = {
  session?: number | "live";
  lap?: number;
  view?: TuneView;
};

export const Route = createFileRoute("/f125/tune/$tuningSessionId")({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): TuneSearch => ({
    session: search.session === "live" ? "live" : search.session != null ? Number(search.session) : undefined,
    lap: search.lap != null ? Number(search.lap) : undefined,
    view: VIEWS.includes(search.view as TuneView) ? (search.view as TuneView) : undefined,
  }),
});

function RouteComponent() {
  const { tuningSessionId } = Route.useParams();
  return <TuningSessionWorkspace gameId="f1-2025" tuningSessionId={Number(tuningSessionId)} />;
}
