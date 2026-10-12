import { useState, type ComponentProps } from "react";
import { Eye, EyeOff } from "lucide-react";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel, FieldGroup, FieldDescription } from "@/components/ui/field";
import { InputGroup, InputGroupInput, InputGroupAddon, InputGroupButton } from "@/components/ui/input-group";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Switch } from "@/components/ui/switch";

export function accessErrorMessage(error: unknown) {
  const code = error instanceof Error ? error.message : "request_failed";
  const messages: Record<string, () => string> = {
    password_length: m.access_password_length,
    incorrect_password: m.access_incorrect_password,
    try_later: m.access_try_later,
    already_configured: m.access_already_configured,
    environment_override: m.access_override,
    confirm_exposure: m.access_confirm_warning,
    invalid_network: m.access_invalid_network,
  };
  return (messages[code] ?? m.access_request_failed)();
}

export function PasswordField({
  id,
  label,
  value,
  onChange,
  invalid = false,
  autoComplete = "new-password",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  autoComplete?: ComponentProps<"input">["autoComplete"];
}) {
  const [shown, setShown] = useState(false);
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id={id}
          type={shown ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          aria-invalid={invalid}
          maxLength={1024}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton type="button" size="icon-xs" aria-label={shown ? m.access_hide_password() : m.access_show_password()} onClick={() => setShown((current) => !current)}>
            {shown ? <EyeOff /> : <Eye />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </Field>
  );
}

export function AccessSetupForm({
  setup = false,
  protectedAccess = false,
  overridden = false,
  language,
  onComplete,
}: {
  setup?: boolean;
  protectedAccess?: boolean;
  overridden?: boolean;
  language?: string;
  onComplete: () => Promise<void>;
}) {
  const [selectedMode, setSelectedMode] = useState("");
  const mode = selectedMode || "enabled";
  const showForm = setup || !protectedAccess || selectedMode !== "";
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [current, setCurrent] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const tooShort = mode === "enabled" && password.length > 0 && password.length < 8;
  const mismatch = mode === "enabled" && confirmation.length > 0 && password !== confirmation;
  const valid = mode === "disabled" ? confirmed : password.length >= 8 && password === confirmation;
  const submitLabel = setup ? m.common_next()
    : !protectedAccess ? m.access_enable()
    : mode === "disabled" ? m.access_confirm_settings()
    : m.access_save();
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!showForm || !valid) return;
        setPending(true);
        setError("");
        try {
          const json = { password: mode === "enabled" ? password : null, exposureConfirmed: confirmed, language };
          const response = setup ? await client.api.auth.setup.$post({ json }) : await client.api.auth.password.$put({ json: { ...json, currentPassword: current } });
          if (!response.ok) {
            const body = await response.json();
            throw new Error("error" in body && typeof body.error === "string" ? body.error : "request_failed");
          }
          setPassword("");
          setConfirmation("");
          setCurrent("");
          await onComplete();
          setSelectedMode("");
          setConfirmed(false);
        } catch (failure) {
          setError(accessErrorMessage(failure));
        } finally {
          setPending(false);
        }
      }}
    >
      {overridden && (
        <Alert>
          <AlertTitle>{m.access_override_title()}</AlertTitle>
          <AlertDescription>{m.access_override()}</AlertDescription>
        </Alert>
      )}
      {(setup || protectedAccess) && (
        <ToggleGroup
          value={setup ? [mode] : selectedMode ? [selectedMode] : []}
          onValueChange={(values) => {
            setSelectedMode(values[0] ?? "");
          }}
          orientation="vertical"
          variant="outline"
          disabled={overridden}
          aria-label={m.access_protection()}
        >
          <ToggleGroupItem value="enabled">{protectedAccess ? m.access_change_password() : m.access_enable()}</ToggleGroupItem>
          {(!setup || mode !== "disabled") && (
            <ToggleGroupItem value="disabled">{setup ? m.access_continue_unprotected() : m.access_disable()}</ToggleGroupItem>
          )}
        </ToggleGroup>
      )}
      {showForm && (
        <FieldGroup>
          {!setup && protectedAccess && <PasswordField id="access-current-password" label={m.access_current_password()} value={current} onChange={setCurrent} autoComplete="current-password" />}
          {mode === "enabled" ? (
            <>
              <PasswordField id="access-password" label={protectedAccess ? m.access_new_password() : m.access_password()} value={password} onChange={setPassword} invalid={tooShort} />
              <FieldDescription>{m.access_password_length()}</FieldDescription>
              <PasswordField
                id="access-confirm-password"
                label={protectedAccess ? m.access_confirm_new_password() : m.access_confirm_password()}
                value={confirmation}
                onChange={setConfirmation}
                invalid={mismatch}
              />
              {mismatch && <p role="alert">{m.access_password_mismatch()}</p>}
            </>
          ) : (
            <>
              <Alert>
                <AlertTitle>{m.access_warning_title()}</AlertTitle>
                <AlertDescription>{m.access_warning()}</AlertDescription>
              </Alert>
              <Field orientation="horizontal">
                <Switch id="access-exposure" checked={confirmed} onCheckedChange={setConfirmed} />
                <FieldLabel htmlFor="access-exposure">{m.access_confirm_warning()}</FieldLabel>
              </Field>
            </>
          )}
        </FieldGroup>
      )}
      {error && <p role="alert">{error}</p>}
      {showForm && (
        <Button type="submit" disabled={pending || !valid || overridden || (!setup && protectedAccess && !current)}>
          {submitLabel}
        </Button>
      )}
    </form>
  );
}
