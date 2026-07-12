import { TuneSettingsPanel } from "@/components/tune/TuneSettingsPanel";
import { CATEGORY_LABELS } from "@/components/tune/tune-constants";
import type { TuneRow } from "./types";

const SOURCE_LABEL: Record<TuneRow["source"], string> = {
  builtin: "Built-in",
  community: "Community",
  user: "Yours",
};

export interface TuneBrowserRowProps {
  row: TuneRow;
  rank: number;
  isOpen: boolean;
  onToggle: () => void;
  onClone: (row: TuneRow) => void;
  onEdit: (row: TuneRow) => void;
  onDelete: (row: TuneRow) => void;
}

export function TuneBrowserRow({ row, rank, isOpen, onToggle, onClone, onEdit, onDelete }: TuneBrowserRowProps) {
  const hasTime = row.lapTimeSec != null;
  const isUser = row.source === "user";
  const isTrackTune = row.trackOrdinal != null;
  const catLabel = CATEGORY_LABELS[row.category] ?? row.category;

  return (
    <div className={`tt-rowwrap ${isOpen ? "open" : ""}`}>
      <button type="button" className="tt-trow" onClick={onToggle}>
        <span className={`tt-pos ${rank === 1 && hasTime ? "p1" : ""}`}>{rank}</span>
        <span className="tt-namecell">
          <span className="tt-nrow">
            <span className={`tt-marker ${row.source}`} />
            <span style={{ minWidth: 0 }}>
              <span className="tt-nm">{row.name}</span>
              <span className="tt-sub">
                {SOURCE_LABEL[row.source]}
                {row.category ? ` · ${catLabel}` : ""}
              </span>
            </span>
          </span>
        </span>
        <span className={`tt-authcell tt-col-hide ${isUser ? "user" : ""}`}>
          <span className="ah" />
          <span>{row.author}</span>
        </span>
        <span className={`tt-catpill tt-col-hide ${isTrackTune ? "trk" : ""}`}>{isTrackTune && row.lapTimeTrack ? row.lapTimeTrack : catLabel}</span>
        <span className={`tt-lapcol ${hasTime ? "" : "none"}`}>
          {hasTime ? row.lapTimeRaw : "—"}
          <span className="dl">{hasTime ? (row.lapTimeTrack ?? "LAP") : "NO TIME"}</span>
        </span>
        <span className="tt-chev tt-col-hide">›</span>
      </button>
      {isOpen && (
        <div className="tt-detail">
          {row.description && <p className="tt-desc">{row.description}</p>}
          <TuneSettingsPanel settings={row.settings} />
          <div className="tt-dact">
            {isUser ? (
              <>
                <button type="button" className="tt-dbtn p" onClick={() => onEdit(row)}>
                  Edit
                </button>
                <button type="button" className="tt-dbtn danger" onClick={() => onDelete(row)}>
                  Delete
                </button>
              </>
            ) : (
              <button type="button" className="tt-dbtn p" onClick={() => onClone(row)}>
                Clone to garage
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
