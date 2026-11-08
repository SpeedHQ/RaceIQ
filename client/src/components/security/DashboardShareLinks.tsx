import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Copy } from "lucide-react";
import { m } from "@/paraglide/messages";
import { Button } from "@/components/ui/button";
import { FieldSet, FieldLegend, FieldDescription } from "@/components/ui/field";
import type { AuthStatus } from "@/lib/dashboard-auth";
import { dashboardShareTargets } from "./dashboard-share";

async function copyLink(url: string) {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(url);
      return;
    }
  } catch {
    // Plain HTTP LAN pages may lack clipboard access. Keep copying available
    // through the browser's synchronous, user-initiated copy command.
  }
  const previousFocus = document.activeElement;
  const input = document.createElement("textarea");
  input.value = url;
  input.readOnly = true;
  input.style.position = "fixed";
  input.style.opacity = "0";
  (previousFocus?.parentElement ?? document.body).append(input);
  try {
    input.focus({ preventScroll: true });
    input.select();
    if (!document.execCommand("copy")) throw new Error("copy_failed");
  } finally {
    input.remove();
    if (previousFocus instanceof HTMLElement) previousFocus.focus();
  }
}

export function DashboardShareLinks({ status }: { status: AuthStatus }) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const targets = dashboardShareTargets(status);

  if (targets.length === 0) return null;
  return (
    <FieldSet>
      <FieldLegend>{m.access_share_title()}</FieldLegend>
      <FieldDescription>{status.protected ? m.access_share_protected() : m.access_share_unprotected()}</FieldDescription>
      <ul className="flex flex-col gap-4">
        {targets.map(({ origin }) => {
          const url = `${origin}/`;
          return (
            <li key={origin} className="flex flex-wrap items-center gap-4">
              <QRCodeSVG value={url} size={144} marginSize={4} role="img" aria-label={m.access_qr_label({ url })} />
              <div className="flex min-w-0 flex-col items-start gap-2">
                <a className="break-all" href={url} target="_blank" rel="noreferrer">{url}</a>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={m.access_copy_link_label({ url })}
                  onClick={async () => {
                    setMessage("");
                    setError("");
                    try {
                      await copyLink(url);
                      setMessage(m.access_link_copied());
                    } catch {
                      setError(m.access_copy_failed());
                    }
                  }}
                >
                  <Copy data-icon="inline-start" />
                  {m.access_copy_link()}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </FieldSet>
  );
}
