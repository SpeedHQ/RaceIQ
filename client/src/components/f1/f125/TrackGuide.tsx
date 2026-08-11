import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { F125TrackData, F125TrackSummary } from "@/components/f1/f125/types";
import { Table, TBody, TD, TRow } from "@/components/ui/AppTable";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";

function sourceDisplayName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function toEmbedUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com") && u.searchParams.has("v")) return `https://www.youtube.com/embed/${u.searchParams.get("v")}`;
    if (u.hostname === "youtu.be") return `https://www.youtube.com/embed${u.pathname}`;
  } catch {}
  return url;
}

export function F125TrackGuide({ trackOrdinal }: { trackOrdinal: number }) {
  const { data: tracks = [] } = useQuery<F125TrackSummary[]>({
    queryKey: ["f125-tracks"],
    queryFn: () => client.api["f1-25"].tracks.$get().then((r) => r.json() as unknown as F125TrackSummary[]),
  });
  const trackSlug = tracks.find((t) => t.trackOrdinal === trackOrdinal)?.trackSlug;
  const { data: trackData } = useQuery<F125TrackData>({
    queryKey: ["f125-setups", trackSlug],
    queryFn: () => client.api["f1-25"].setups.$get({ query: { track: trackSlug! } }).then((r) => r.json() as unknown as F125TrackData),
    enabled: !!trackSlug,
  });

  const guides = trackData?.trackGuide ?? [];
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [contentTab, setContentTab] = useState<"guide" | "setup">("guide");
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  const activeGuide = guides.find((g) => g.source === selectedSource) ?? guides[0];

  if (guides.length === 0) return <div className="text-app-text-secondary text-app-compact p-4">{m.f1setup_no_guide()}</div>;

  return (
    <div className="flex h-full min-h-0 gap-3">
      {/* Source list */}
      <div className={`flex w-full shrink-0 flex-col gap-1 @3xl/workspace:w-56 ${mobileView === "detail" ? "hidden @3xl/workspace:flex" : ""}`}>
        {guides.map((g) => {
          const isActive = g.source === activeGuide?.source;
          const sectionCount = g.sections?.length ?? 0;
          return (
            <Button
              key={g.source}
              variant="plain"
              size="content"
              onClick={() => {
                setSelectedSource(g.source);
                setMobileView("detail");
              }}
              className={`text-left px-2 py-2 rounded border transition-colors ${
                isActive ? "border-app-accent/40 bg-app-accent/10" : "border-app-border hover:border-app-border-hover bg-app-surface-alt/30 hover:bg-app-surface-hover"
              }`}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <span className={`text-app-subtext font-medium ${isActive ? "text-app-accent" : "text-app-text"}`}>{sourceDisplayName(g.source)}</span>
                {sectionCount > 0 && <span className="px-1 py-0.5 text-app-nano font-bold uppercase rounded bg-status-info/20 text-status-info">{m.label_text()}</span>}
                {g.videoUrl && (
                  <span className="provider-badge px-1 py-0.5 text-app-nano font-bold uppercase rounded" data-provider-brand="youtube">
                    YT
                  </span>
                )}
              </div>
              <Table density="compact" fit variant="embedded">
                <TBody>
                  {g.setupTips && (
                    <TRow>
                      <TD tone="dim">{m.f1setup_setup_tips_label()}</TD>
                      <TD>Yes</TD>
                    </TRow>
                  )}
                  {g.drivingTips && (
                    <TRow>
                      <TD tone="dim">{m.f1setup_driving_tips_label()}</TD>
                      <TD>Yes</TD>
                    </TRow>
                  )}
                </TBody>
              </Table>
            </Button>
          );
        })}
      </div>

      {/* Guide content */}
      {activeGuide && (
        <div className={`min-h-0 min-w-0 flex-1 flex-col ${mobileView === "list" ? "hidden @3xl/workspace:flex" : "flex"}`}>
          {/* Back button (mobile only) */}
          <Button variant="app-outline" size="default" onClick={() => setMobileView("list")} className="mb-3 self-start @3xl/workspace:hidden">
            &larr; Back to guides
          </Button>
          {/* Content tabs + source link */}
          <div className="flex items-center gap-2 mb-2 shrink-0 flex-wrap">
            <Button
              onClick={() => setContentTab("guide")}
              className={`text-app-label px-2 py-0.5 rounded border transition-colors ${contentTab === "guide" ? "border-app-accent/50 bg-app-accent/15 text-app-accent" : "border-app-border text-app-text-secondary hover:text-app-text"}`}
            >
              {m.f1setup_guide_tab()}
            </Button>
            {activeGuide.setupTips && (
              <Button
                onClick={() => setContentTab("setup")}
                className={`text-app-label px-2 py-0.5 rounded border transition-colors ${contentTab === "setup" ? "border-app-accent/50 bg-app-accent/15 text-app-accent" : "border-app-border text-app-text-secondary hover:text-app-text"}`}
              >
                {m.f1setup_setup_tips_tab()}
              </Button>
            )}
            {activeGuide.source && (
              <a href={activeGuide.source} target="_blank" rel="noopener noreferrer" className="text-app-caption text-app-text-muted hover:text-app-text underline underline-offset-2">
                View on {sourceDisplayName(activeGuide.source)} ↗
              </a>
            )}
          </div>
          <div className="overflow-y-auto rounded-lg border border-app-border/15 bg-app-surface-alt/15 p-3 flex-1">
            {contentTab === "guide" && (
              <>
                {activeGuide.videoUrl && (
                  <div className="mb-4 w-full overflow-hidden rounded-lg border border-app-border/30 @3xl/workspace:float-right @3xl/workspace:ml-4 @3xl/workspace:mb-4 @3xl/workspace:w-[45%]">
                    <div className="relative w-full" style={{ paddingBottom: "56.25%" }}>
                      <iframe
                        src={toEmbedUrl(activeGuide.videoUrl)}
                        title={m.f1setup_track_guide()}
                        className="absolute inset-0 w-full h-full"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                      />
                    </div>
                  </div>
                )}
                {activeGuide.sections?.map((s) => (
                  <div key={`${s.heading}-${s.body}`} className="mb-6">
                    {s.heading && <p className="text-app-text font-semibold text-sm mb-1">{s.heading}</p>}
                    <p className="text-app-text-secondary text-sm leading-relaxed whitespace-pre-line">{s.body}</p>
                  </div>
                ))}
              </>
            )}
            {contentTab === "setup" && (
              <>
                {activeGuide.setupTips && (
                  <div className="mb-4">
                    <p className="text-app-text-secondary text-sm leading-relaxed whitespace-pre-line">{activeGuide.setupTips}</p>
                  </div>
                )}
                {activeGuide.drivingTips && (
                  <div className="mb-6">
                    <p className="text-app-text font-semibold text-sm mb-1">{m.f1setup_driving_tips_tab()}</p>
                    <p className="text-app-text-secondary text-sm leading-relaxed whitespace-pre-line">{activeGuide.drivingTips}</p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
