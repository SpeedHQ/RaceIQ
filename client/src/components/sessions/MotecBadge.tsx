import { Badge } from "@/components/ui/badge";
import { m } from "../../paraglide/messages";

export function MotecBadge() {
  return (
    <Badge variant="info" size="compact" title={m.sessions_badge_motec()} aria-label={m.sessions_badge_motec()}>
      MoTeC
    </Badge>
  );
}
