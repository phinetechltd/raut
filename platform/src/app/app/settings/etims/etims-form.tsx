"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Badge, Button, ButtonLink, Callout, Card, Field, Select } from "@/components/ui";
import { ITEM_CLASSES, ITEM_TYPES, PACKAGE_UNITS, QUANTITY_UNITS, TAX_TYPES } from "@/lib/etims-codes";

export interface EtimsState {
  enabled: boolean;
  environment: string;
  autoTransmit: boolean;
  activeFrom: string | null;
  defaultItemClassCode: string;
  defaultItemTypeCode: string;
  defaultTaxTypeCode: string;
  defaultQuantityUnit: string;
  defaultPackageUnit: string;
  defaultOriginNation: string;
  branchName: string | null;
  lastVerifiedAt: string | null;
}

export function EtimsForm({
  initial,
  configured,
  storedPin,
  companyPin,
  readiness,
}: {
  initial: EtimsState;
  configured: boolean;
  storedPin: string | null;
  companyPin: string | null;
  readiness: { productsWithoutClassification: number; customersWithoutPin: number };
}) {
  const router = useRouter();
  const [, start] = useTransition();
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const set = <K extends keyof EtimsState>(k: K, v: EtimsState[K]) =>
    setState((s) => ({ ...s, [k]: v }));

  // Going live without a key would leave the company believing it is filing
  // when nothing can be sent, so it is blocked here as well as on the server.
  const liveWithoutKey = state.enabled && state.environment === "LIVE" && !configured;

  // The stored key belongs to a KRA PIN. If that is not this company's own PIN,
  // every invoice would be filed under someone else's registration.
  const pinMismatch =
    configured && storedPin && companyPin && storedPin.trim() !== companyPin.trim();

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/v1/etims/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error?.message ?? "Could not save");
      } else {
        setSaved(true);
        start(() => router.refresh());
      }
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {!configured && (
        <Callout tone="warning" title="No Digitax API key stored for this company">
          Each company files under its own KRA PIN through its own Digitax
          account, so there is no shared key to fall back on. Add one before
          switching to live.{" "}
          <ButtonLink href="/app/settings/payments" variant="ghost" size="sm">
            Add a key
          </ButtonLink>
        </Callout>
      )}

      {pinMismatch && (
        <Callout tone="danger" title="The stored key is registered to a different KRA PIN">
          The Digitax key on file files as <strong>{storedPin}</strong>, but this
          company is <strong>{companyPin}</strong>. Transmitting would file this
          company&apos;s sales under another taxpayer&apos;s registration. Correct
          one of the two before switching on.
        </Callout>
      )}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="font-medium">eTIMS transmission</p>
            <p className="mt-0.5 max-w-md text-sm text-content-muted">
              When off, invoices are issued exactly as they are now and nothing
              is sent to KRA. Turning it off never stops you trading.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={state.enabled}
              onChange={(e) => set("enabled", e.target.checked)}
            />
            {state.enabled ? "On" : "Off"}
          </label>
        </div>

        {state.enabled && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field
              label="Environment"
              hint={
                state.environment === "LIVE"
                  ? "Live files real returns under a real PIN."
                  : "Sandbox transmits nothing to KRA."
              }
            >
              <Select
                value={state.environment}
                onChange={(e) => set("environment", e.target.value)}
              >
                <option value="SANDBOX">Sandbox (test)</option>
                <option value="LIVE">Live</option>
              </Select>
            </Field>

            <Field
              label="Transmit automatically"
              hint="Off means invoices queue until someone releases them."
            >
              <Select
                value={state.autoTransmit ? "yes" : "no"}
                onChange={(e) => set("autoTransmit", e.target.value === "yes")}
              >
                <option value="yes">On issue</option>
                <option value="no">Hold for release</option>
              </Select>
            </Field>

            <Field
              label="File invoices raised from"
              hint="Nothing before this date is sent. Stops switching on from pushing your whole history at KRA."
            >
              <input
                type="date"
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
                value={state.activeFrom ?? ""}
                onChange={(e) => set("activeFrom", e.target.value || null)}
              />
            </Field>

            {state.branchName && (
              <Field label="Registered branch">
                <p className="pt-2 text-sm">
                  {state.branchName}{" "}
                  {state.lastVerifiedAt && (
                    <Badge tone="success">
                      verified {state.lastVerifiedAt.slice(0, 10)}
                    </Badge>
                  )}
                </p>
              </Field>
            )}
          </div>
        )}

        {liveWithoutKey && (
          <p className="mt-3 text-sm text-danger">
            Live mode needs a Digitax API key for this company.
          </p>
        )}
      </Card>

      {state.enabled && (
        <Card>
          <p className="font-medium">Defaults for unclassified products</p>
          <p className="mt-0.5 text-sm text-content-muted">
            KRA will not accept a line without a classification. These are applied
            to any product that has none of its own. They are a legitimate
            starting point, not a substitute for classifying what you sell.
          </p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Item classification">
              <Select
                value={state.defaultItemClassCode}
                onChange={(e) => set("defaultItemClassCode", e.target.value)}
              >
                {Object.entries(ITEM_CLASSES).map(([code, label]) => (
                  <option key={code} value={code}>
                    {code} · {label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Item type">
              <Select
                value={state.defaultItemTypeCode}
                onChange={(e) => set("defaultItemTypeCode", e.target.value)}
              >
                {Object.entries(ITEM_TYPES).map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Tax type">
              <Select
                value={state.defaultTaxTypeCode}
                onChange={(e) => set("defaultTaxTypeCode", e.target.value)}
              >
                {Object.entries(TAX_TYPES).map(([code, t]) => (
                  <option key={code} value={code}>
                    {code} · {t.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Quantity unit">
              <Select
                value={state.defaultQuantityUnit}
                onChange={(e) => set("defaultQuantityUnit", e.target.value)}
              >
                {Object.entries(QUANTITY_UNITS).map(([code, label]) => (
                  <option key={code} value={code}>
                    {code} · {label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Packaging unit">
              <Select
                value={state.defaultPackageUnit}
                onChange={(e) => set("defaultPackageUnit", e.target.value)}
              >
                {Object.entries(PACKAGE_UNITS).map(([code, label]) => (
                  <option key={code} value={code}>
                    {code} · {label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Country of origin">
              <Select
                value={state.defaultOriginNation}
                onChange={(e) => set("defaultOriginNation", e.target.value)}
              >
                <option value="KE">Kenya</option>
                <option value="UG">Uganda</option>
                <option value="TZ">Tanzania</option>
                <option value="CN">China</option>
                <option value="IN">India</option>
                <option value="ZA">South Africa</option>
                <option value="AE">United Arab Emirates</option>
              </Select>
            </Field>
          </div>

          {(readiness.productsWithoutClassification > 0 ||
            readiness.customersWithoutPin > 0) && (
            <div className="mt-4 rounded-md border border-border bg-surface-sunken p-3 text-sm">
              <p className="font-medium">Worth tidying before you go live</p>
              <ul className="mt-1 space-y-0.5 text-content-secondary">
                {readiness.productsWithoutClassification > 0 && (
                  <li>
                    {readiness.productsWithoutClassification} active product
                    {readiness.productsWithoutClassification === 1 ? "" : "s"} will
                    use the default classification.
                  </li>
                )}
                {readiness.customersWithoutPin > 0 && (
                  <li>
                    {readiness.customersWithoutPin} customer
                    {readiness.customersWithoutPin === 1 ? "" : "s"} have no KRA
                    PIN, so they cannot claim the VAT on their invoices.
                  </li>
                )}
              </ul>
            </div>
          )}
        </Card>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}
      {saved && <p className="text-sm text-success">Saved.</p>}

      <div className="flex gap-2">
        <Button onClick={save} disabled={busy || liveWithoutKey}>
          {busy ? "Saving..." : "Save"}
        </Button>
        <ButtonLink href="/app/finance/etims" variant="secondary">
          Transmission log
        </ButtonLink>
      </div>
    </div>
  );
}
