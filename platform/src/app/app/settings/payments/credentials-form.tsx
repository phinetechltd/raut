"use client";

import { useState, useTransition } from "react";

import {
  Badge,
  Button,
  Callout,
  Card,
  Field,
  Input,
  SectionHeading,
} from "@/components/ui";

/**
 * Gateway and eTIMS credential management.
 *
 * Secrets are write-only by design: the server has no endpoint that returns a
 * stored key, so this form can only ever set one. An admin who has lost a key
 * replaces it rather than reading it back, which means a stolen console session
 * cannot be used to lift a merchant account's credentials.
 */

export interface ProviderState {
  provider: string;
  requiredKeys: string[];
  optionalKeys: string[];
  configured: boolean;
  active: boolean;
  label: string | null;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestNote: string | null;
  updatedAt: string | null;
}

const LABELS: Record<string, { title: string; blurb: string }> = {
  MPESA_DARAJA: {
    title: "M-Pesa · Safaricom Daraja",
    blurb:
      "STK push straight to the customer's handset. Needs a paybill or till, its passkey, and the Daraja app credentials.",
  },
  PAYSTACK: {
    title: "Paystack",
    blurb: "Cards, bank and mobile money through a hosted checkout link.",
  },
  KCB_BUNI: {
    title: "KCB Buni",
    blurb: "Collections into a KCB till through the Buni API.",
  },
  DIGITAX: {
    title: "eTIMS · Digitax",
    blurb:
      "Transmits tax invoices to KRA and returns the control code and QR that make an invoice valid.",
  },
};

const KEY_LABELS: Record<string, string> = {
  PAYSTACK_SECRET_KEY: "Secret key",
  PAYSTACK_PUBLIC_KEY: "Public key",
  PAYSTACK_BASE_URL: "API base URL",
  MPESA_CONSUMER_KEY: "Consumer key",
  MPESA_CONSUMER_SECRET: "Consumer secret",
  MPESA_SHORTCODE: "Shortcode (paybill or till)",
  MPESA_PASSKEY: "Passkey",
  MPESA_ENV: "Environment (sandbox / production)",
  MPESA_TRANSACTION_TYPE: "Transaction type",
  MPESA_PARTY_B: "Party B (defaults to shortcode)",
  KCB_CONSUMER_KEY: "Consumer key",
  KCB_CONSUMER_SECRET: "Consumer secret",
  KCB_TILL_NUMBER: "Till number",
  KCB_WEBHOOK_SECRET: "Webhook secret",
  KCB_ENV: "Environment (sandbox / production)",
  KCB_BASE_URL: "API base URL",
  DIGITAX_API_KEY: "API key",
  DIGITAX_API_SECRET: "API secret",
  DIGITAX_TIN: "KRA PIN / TIN",
  DIGITAX_ENV: "Environment (sandbox / production)",
  DIGITAX_BASE_URL: "API base URL",
  DIGITAX_BRANCH_ID: "Branch id",
};

async function call(method: string, body: unknown) {
  const res = await fetch("/api/v1/settings/credentials", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message ?? "Request failed");
  return json?.data ?? json;
}

function ProviderCard({
  state,
  onChanged,
}: {
  state: ProviderState;
  onChanged: () => void;
}) {
  const meta = LABELS[state.provider] ?? { title: state.provider, blurb: "" };
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<unknown>, success: string) =>
    start(async () => {
      setMessage(null);
      try {
        const result = (await fn()) as { ok?: boolean; note?: string };
        if (result && result.ok === false) {
          setMessage({ tone: "bad", text: result.note ?? "That did not work" });
        } else {
          setMessage({ tone: "ok", text: result?.note ?? success });
          setValues({});
          setOpen(false);
        }
        onChanged();
      } catch (error) {
        setMessage({ tone: "bad", text: (error as Error).message });
      }
    });

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold tracking-tight">{meta.title}</h3>
            {state.configured ? (
              <Badge tone={state.active ? "success" : "neutral"}>
                {state.active ? "Active" : "Disabled"}
              </Badge>
            ) : (
              <Badge tone="neutral">Not configured</Badge>
            )}
            {state.label ? (
              <code className="text-content-muted text-xs">{state.label}</code>
            ) : null}
          </div>
          <p className="text-content-secondary mt-1 max-w-2xl text-sm">{meta.blurb}</p>
          {state.lastTestedAt ? (
            <p className="text-content-muted mt-2 text-xs">
              Last tested {new Date(state.lastTestedAt).toLocaleString()} —{" "}
              <span className={state.lastTestOk ? "text-success" : "text-danger"}>
                {state.lastTestOk ? "passed" : "failed"}
              </span>
              {state.lastTestNote ? ` · ${state.lastTestNote}` : ""}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {state.configured ? (
            <>
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() =>
                  run(() => call("PATCH", { provider: state.provider, action: "test" }), "Reachable")
                }
              >
                Test
              </Button>
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() =>
                  run(
                    () =>
                      call("PATCH", {
                        provider: state.provider,
                        action: state.active ? "deactivate" : "activate",
                      }),
                    state.active ? "Disabled" : "Enabled",
                  )
                }
              >
                {state.active ? "Disable" : "Enable"}
              </Button>
            </>
          ) : null}
          <Button variant={state.configured ? "secondary" : "primary"} onClick={() => setOpen((v) => !v)}>
            {state.configured ? "Replace keys" : "Add keys"}
          </Button>
        </div>
      </div>

      {message ? (
        <div className="mt-4">
          <Callout tone={message.tone === "ok" ? "success" : "danger"}>
            {message.text}
          </Callout>
        </div>
      ) : null}

      {open ? (
        <form
          className="mt-5 grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () => call("POST", { provider: state.provider, values }),
              "Saved. Test it to confirm the account answers.",
            );
          }}
        >
          {[...state.requiredKeys, ...state.optionalKeys].map((key) => {
            const required = state.requiredKeys.includes(key);
            return (
              <Field
                key={key}
                label={`${KEY_LABELS[key] ?? key}${required ? "" : " (optional)"}`}
              >
                <Input
                  // type=password on everything: an admin configuring a gateway
                  // is often sharing their screen with whoever set the account up.
                  type="password"
                  autoComplete="off"
                  required={required}
                  value={values[key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                  placeholder={state.configured ? "•••••• (unchanged)" : ""}
                />
              </Field>
            );
          })}

          <div className="sm:col-span-2 flex gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save credentials"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            {state.configured ? (
              <Button
                type="button"
                variant="danger"
                disabled={pending}
                onClick={() =>
                  run(
                    () => call("PATCH", { provider: state.provider, action: "delete" }),
                    "Removed",
                  )
                }
              >
                Remove
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}
    </Card>
  );
}

export function CredentialsForm({
  initial,
  vaultAvailable,
}: {
  initial: ProviderState[];
  vaultAvailable: boolean;
}) {
  const [providers, setProviders] = useState(initial);

  const refresh = async () => {
    const res = await fetch("/api/v1/settings/credentials");
    const json = await res.json().catch(() => null);
    if (json?.data?.providers) setProviders(json.data.providers);
  };

  return (
    <div className="space-y-6">
      {!vaultAvailable ? (
        <Callout tone="warning">
          This deployment has no <code>CREDENTIALS_KEY</code>, so credentials
          cannot be encrypted and will not be accepted. Generate a 32-byte key,
          set it in the server environment and restart before adding gateways.
        </Callout>
      ) : null}

      <div>
        <SectionHeading
          title="Collections"
          description="Choose which gateways this company accepts. Each uses your own merchant account — money settles to you, not to the platform."
        />
        <div className="mt-4 space-y-4">
          {providers
            .filter((p) => p.provider !== "DIGITAX")
            .map((p) => (
              <ProviderCard key={p.provider} state={p} onChanged={refresh} />
            ))}
        </div>
      </div>

      <div>
        <SectionHeading
          title="Tax"
          description="Transmission of tax invoices to KRA."
        />
        <div className="mt-4 space-y-4">
          {providers
            .filter((p) => p.provider === "DIGITAX")
            .map((p) => (
              <ProviderCard key={p.provider} state={p} onChanged={refresh} />
            ))}
        </div>
      </div>
    </div>
  );
}
