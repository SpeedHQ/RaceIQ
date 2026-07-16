import { createFileRoute } from "@tanstack/react-router";
import { TuneDashboard } from "../../components/tunes/TuneDashboard";

export type TuneView = "overview" | "s1" | "s2" | "s3";
const VIEWS: TuneView[] = ["overview", "s1", "s2", "s3"];

export type TuneSearch = {
  /** Selected session: a session id, or "live" to follow the on-track session. */
  session?: number | "live";
  /** Selected lap id to analyse within that session. */
  lap?: number;
  /** Active review view: the 3-sector overview or a per-sector deep dive. */
  view?: TuneView;
};

export const Route = createFileRoute("/ac-evo/tune")({
  component: () => <TuneDashboard gameId="ac-evo" />,
  validateSearch: (search: Record<string, unknown>): TuneSearch => ({
    session: search.session === "live" ? "live" : search.session != null ? Number(search.session) : undefined,
    lap: search.lap != null ? Number(search.lap) : undefined,
    view: VIEWS.includes(search.view as TuneView) ? (search.view as TuneView) : undefined,
  }),
});
