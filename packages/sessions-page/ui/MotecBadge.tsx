import { useSessionsPageHost } from "./host";

export function MotecBadge() {
  const { Badge, m } = useSessionsPageHost();
  return (
    <Badge variant="info" size="compact" title={m.sessions_badge_motec()} aria-label={m.sessions_badge_motec()}>
      MoTeC
    </Badge>
  );
}
