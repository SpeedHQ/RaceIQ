import { useOnlineHost } from "../hooks/raceiq-online";

export function OnlineTimestamp({ value }: { value: string | null }) {
  const { m, getLocale } = useOnlineHost();
  return value && Number.isFinite(Date.parse(value))
    ? <time dateTime={value} title={value}>{new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))}</time>
    : <>{m.online_queue_unknown()}</>;
}
