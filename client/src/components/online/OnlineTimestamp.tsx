import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";

export function OnlineTimestamp({ value }: { value: string | null }) {
  return value && Number.isFinite(Date.parse(value))
    ? <time dateTime={value} title={value}>{new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))}</time>
    : <>{m.online_queue_unknown()}</>;
}
