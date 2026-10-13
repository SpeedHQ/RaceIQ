import { useId, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { Eye, EyeOff } from "lucide-react";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel, FieldGroup, FieldDescription } from "@/components/ui/field";
import { InputGroup, InputGroupInput, InputGroupAddon, InputGroupButton } from "@/components/ui/input-group";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { ToggleGroup03 } from "@/components/shadcn-studio/toggle-group/toggle-group-03";

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
  hint,
  value,
  onChange,
  invalid = false,
  autoComplete = "new-password",
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  autoComplete?: ComponentProps<"input">["autoComplete"];
}) {
  const [shown, setShown] = useState(false);
  return (
    <Field data-invalid={invalid}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {hint && <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>}
      </div>
      <InputGroup>
        <InputGroupInput
          id={id}
          type={shown ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          aria-invalid={invalid}
          aria-describedby={hint ? `${id}-hint` : undefined}
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
  submitContainer,
  onComplete,
}: {
  setup?: boolean;
  protectedAccess?: boolean;
  overridden?: boolean;
  language?: string;
  submitContainer?: HTMLElement | null;
  onComplete: () => Promise<void>;
}) {
  const formId = useId();
  const [mode, setMode] = useState("enabled");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [current, setCurrent] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const tooShort = mode === "enabled" && password.length > 0 && password.length < 8;
  const mismatch = mode === "enabled" && confirmation.length > 0 && password !== confirmation;
  const valid = mode === "disabled" || (password.length >= 8 && password === confirmation);
  const submitLabel = setup ? m.common_next() : mode === "disabled" ? m.access_confirm_settings() : !protectedAccess ? m.access_enable() : m.access_save();
  const submitButton = (
    <Button variant="app-primary" size="sm" className="self-start" form={formId} type="submit" disabled={pending || !valid || overridden || (!setup && protectedAccess && !current)}>
      {submitLabel}
    </Button>
  );
  return (
    <form
      id={formId}
      className="flex w-full max-w-md flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid) return;
        setPending(true);
        setError("");
        try {
          const json = { password: mode === "enabled" ? password : null, exposureConfirmed: mode === "disabled", language };
          const response = setup ? await client.api.auth.setup.$post({ json }) : await client.api.auth.password.$put({ json: { ...json, currentPassword: current } });
          if (!response.ok) {
            const body = await response.json();
            throw new Error("error" in body && typeof body.error === "string" ? body.error : "request_failed");
          }
          setPassword("");
          setConfirmation("");
          setCurrent("");
          await onComplete();
          setMode("enabled");
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
      <fieldset disabled={overridden || pending} className="min-w-0 w-fit max-w-full">
        <ToggleGroup03
          ariaLabel={m.access_protection()}
          value={mode}
          onValueChange={setMode}
          options={[
            { value: "enabled", label: protectedAccess ? m.access_change_password() : m.access_enable() },
            { value: "disabled", label: setup ? m.access_continue_unprotected() : m.access_disable() },
          ]}
        />
      </fieldset>
          <FieldGroup>
            {!setup && protectedAccess && <PasswordField id="access-current-password" label={m.access_current_password()} value={current} onChange={setCurrent} autoComplete="current-password" />}
            {mode === "enabled" ? (
              <>
                <PasswordField id="access-password" label={protectedAccess ? m.access_new_password() : m.access_password()} hint={m.access_password_length()} value={password} onChange={setPassword} invalid={tooShort} />
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
              <Alert>
                <AlertTitle>{m.access_warning_title()}</AlertTitle>
                <AlertDescription>{m.access_warning()}</AlertDescription>
              </Alert>
            )}
          </FieldGroup>
          {error && <p role="alert">{error}</p>}
          {setup ? submitContainer && createPortal(submitButton, submitContainer) : submitButton}
    </form>
  );
}
