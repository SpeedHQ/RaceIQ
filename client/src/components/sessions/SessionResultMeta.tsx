import type { SessionMeta } from "@shared/racing/sessions/types";
import { Badge } from "@/components/ui/badge";

export function SessionResultMeta({ session }: { session: SessionMeta }) {
  const position = session.finishingPosition;
  return position != null ? (
    <Badge variant="neutral" size="compact">
      P{position}
    </Badge>
  ) : (
    <span className="text-app-text/60">—</span>
  );
}
