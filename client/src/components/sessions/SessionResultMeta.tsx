import type { SessionMeta } from "@raceiq/shared/racing/sessions/types";
import { isPracticeSession } from "@raceiq/shared/racing/sessions/session-type";
import { Badge } from "@/components/ui/badge";

export function SessionResultMeta({ session }: { session: SessionMeta }) {
  const position = isPracticeSession(session.sessionType) ? null : session.finishingPosition;
  return position != null ? (
    <Badge variant="neutral" size="compact">
      P{position}
    </Badge>
  ) : (
    <span className="text-app-text/60">—</span>
  );
}
