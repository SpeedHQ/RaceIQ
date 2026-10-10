import { Badge } from "@/components/ui/badge";

export function SessionTypeBadge({ type, label }: { type?: string | null; label?: string }) {
  const normalized = type?.trim();
  if (!normalized || normalized.toLowerCase() === "unknown") return null;

  const fullLabel = label ?? normalized.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  const category = normalized.toLowerCase();
  const variant = category.startsWith("practice") || category === "test-day" ? "info"
    : category.includes("qual") || category.includes("shootout") ? "warning"
    : category.startsWith("race") || category.startsWith("sprint") ? "success"
    : "catalog-category";

  return (
    <Badge variant={variant} size="compact" className="min-w-5 shrink-0 text-app-label" title={fullLabel} aria-label={fullLabel}>
      {normalized.charAt(0).toUpperCase()}
    </Badge>
  );
}
