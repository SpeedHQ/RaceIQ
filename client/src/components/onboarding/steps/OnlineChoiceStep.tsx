import { Monitor } from "lucide-react";
import { useId } from "react";
import { SiDiscord } from "react-icons/si";
import { m } from "@/paraglide/messages";

type OnlineChoice = "discord" | "offline";

export function OnlineChoiceStep({ selected, onSelect }: { selected: OnlineChoice | null; onSelect: (choice: OnlineChoice) => void }) {
  const id = useId();
  return (
    <section className="mx-auto max-w-2xl py-2">
      <h2 id={id} className="mb-6 text-xl font-semibold text-app-text">{m.ob_online_choice_title()}</h2>
      <fieldset aria-labelledby={id} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <label className={`cursor-pointer rounded-xl border p-5 transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-app-accent @3xl/onboarding:p-6 ${selected === "discord" ? "border-app-accent/60 bg-app-accent/5" : "border-app-border bg-app-surface-alt/40 hover:border-app-border-hover hover:bg-app-surface-hover"}`}>
          <span className="mb-5 flex items-center gap-3">
            <SiDiscord className="h-8 w-8 shrink-0 text-app-text" aria-hidden="true" />
            <span id={`${id}-online-title`} className="text-lg font-semibold text-app-text">{m.online_onboarding_title()}</span>
            <input type="radio" name={`${id}-mode`} value="discord" checked={selected === "discord"} onChange={() => onSelect("discord")} aria-labelledby={`${id}-online-title`} aria-describedby={`${id}-online-description`} className="ml-auto h-4 w-4 shrink-0 appearance-none rounded-full border border-app-text-muted bg-transparent checked:border-app-accent checked:bg-app-accent" />
          </span>
          <span id={`${id}-online-description`} className="block text-sm leading-6 text-app-text-secondary">{m.ob_online_choice_online_desc()}</span>
        </label>
        <label className={`cursor-pointer rounded-xl border p-5 transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-app-accent @3xl/onboarding:p-6 ${selected === "offline" ? "border-app-accent/60 bg-app-accent/5" : "border-app-border bg-app-surface-alt/40 hover:border-app-border-hover hover:bg-app-surface-hover"}`}>
          <span className="mb-5 flex items-center gap-3">
            <Monitor className="h-8 w-8 shrink-0 text-app-text-secondary" strokeWidth={1.5} aria-hidden="true" />
            <span id={`${id}-offline-title`} className="text-lg font-semibold text-app-text">{m.ob_online_choice_offline_title()}</span>
            <input type="radio" name={`${id}-mode`} value="offline" checked={selected === "offline"} onChange={() => onSelect("offline")} aria-labelledby={`${id}-offline-title`} aria-describedby={`${id}-offline-description`} className="ml-auto h-4 w-4 shrink-0 appearance-none rounded-full border border-app-text-muted bg-transparent checked:border-app-accent checked:bg-app-accent" />
          </span>
          <span id={`${id}-offline-description`} className="block text-sm leading-6 text-app-text-secondary">{m.ob_online_choice_offline_desc()}</span>
        </label>
      </fieldset>
    </section>
  );
}
