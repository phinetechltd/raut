"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  apiClient,
  useFormSubmit,
  Button,
  Field,
  Input,
  Modal,
  ModalButton,
  Select,
  Textarea,
} from "@/components/ui";

interface Option {
  id: string;
  name: string;
}

// ── one-off ──────────────────────────────────────────────────────────────

export function ComposeDialog({ customers }: { customers: Option[] }) {
  return (
    <ModalButton label="Compose email" title="Compose email" description="A direct message to one customer. Not marketing — no unsubscribe footer is added." width="max-w-xl" variant="secondary">
      {(close) => <ComposeForm customers={customers} onClose={close} />}
    </ModalButton>
  );
}

function ComposeForm({ customers, onClose }: { customers: Option[]; onClose: (saved: boolean) => void }) {
  const router = useRouter();
  const { busy, error, submit } = useFormSubmit();
  const [f, setF] = useState({ customerId: customers[0]?.id ?? "", subject: "", body: "" });
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));

  async function save() {
    await submit(
      () =>
        apiClient("/api/v1/email/send", {
          method: "POST",
          body: { customerId: f.customerId || null, subject: f.subject, html: `<p>${f.body.replace(/\n/g, "<br/>")}</p>` },
        }),
      { onSuccess: () => { onClose(true); router.refresh(); } },
    );
  }

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Field label="To customer" htmlFor="em-cust" required>
        <Select id="em-cust" value={f.customerId} onChange={(e) => set("customerId", e.target.value)}>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Field>
      <Field label="Subject" htmlFor="em-subj" required>
        <Input id="em-subj" value={f.subject} onChange={(e) => set("subject", e.target.value)} required minLength={1} />
      </Field>
      <Field label="Message" htmlFor="em-body" required>
        <Textarea id="em-body" rows={6} value={f.body} onChange={(e) => set("body", e.target.value)} required />
      </Field>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !f.customerId || !f.subject.trim() || !f.body.trim()}>
          {busy ? "Sending…" : "Send email"}
        </Button>
      </div>
    </form>
  );
}

// ── campaign ────────────────────────────────────────────────────────────────

export function CampaignDialog({ territories }: { territories: Option[] }) {
  return (
    <ModalButton label="+ New campaign" title="New email campaign" description="A bulk email to a segment of customers. An unsubscribe link is added automatically." width="max-w-xl">
      {(close) => <CampaignForm territories={territories} onClose={close} />}
    </ModalButton>
  );
}

function CampaignForm({ territories, onClose }: { territories: Option[]; onClose: (saved: boolean) => void }) {
  const router = useRouter();
  const { busy, error, submit } = useFormSubmit();
  const [f, setF] = useState({ name: "", subject: "", body: "", segment: "", customerType: "", territoryId: "" });
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));

  async function save() {
    await submit(
      () =>
        apiClient("/api/v1/email/campaigns", {
          method: "POST",
          body: {
            name: f.name,
            subject: f.subject,
            bodyHtml: `<p>${f.body.replace(/\n/g, "<br/>")}</p>`,
            segment: f.segment || null,
            customerType: f.customerType || null,
            territoryId: f.territoryId || null,
          },
        }),
      { onSuccess: () => { onClose(true); router.refresh(); } },
    );
  }

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Field label="Campaign name" htmlFor="c-name" required>
        <Input id="c-name" value={f.name} onChange={(e) => set("name", e.target.value)} required minLength={2} placeholder="Internal name" />
      </Field>
      <Field label="Subject" htmlFor="c-subj" required>
        <Input id="c-subj" value={f.subject} onChange={(e) => set("subject", e.target.value)} required minLength={1} />
      </Field>
      <Field label="Message" htmlFor="c-body" required>
        <Textarea id="c-body" rows={6} value={f.body} onChange={(e) => set("body", e.target.value)} required placeholder="Plain text; line breaks are kept." />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Segment" htmlFor="c-seg">
          <Select id="c-seg" value={f.segment} onChange={(e) => set("segment", e.target.value)}>
            <option value="">All segments</option>
            <option value="A">A</option>
            <option value="B">B</option>
            <option value="C">C</option>
          </Select>
        </Field>
        <Field label="Type" htmlFor="c-type">
          <Select id="c-type" value={f.customerType} onChange={(e) => set("customerType", e.target.value)}>
            <option value="">All types</option>
            <option value="RETAIL">Retail</option>
            <option value="WHOLESALE">Wholesale</option>
            <option value="DISTRIBUTOR">Distributor</option>
            <option value="INSTITUTION">Institution</option>
          </Select>
        </Field>
        <Field label="Territory" htmlFor="c-terr">
          <Select id="c-terr" value={f.territoryId} onChange={(e) => set("territoryId", e.target.value)}>
            <option value="">All territories</option>
            {territories.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
      </div>
      <p className="text-xs text-content-muted">Only active customers with an email address receive it, and anyone who has unsubscribed is skipped.</p>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !f.name.trim() || !f.subject.trim() || !f.body.trim()}>
          {busy ? "Saving…" : "Save draft"}
        </Button>
      </div>
    </form>
  );
}

export function SendCampaignButton({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const { busy, error, submit } = useFormSubmit();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState<number | null>(null);

  async function openModal() {
    setOpen(true);
    setCount(null);
    const res = await apiClient<{ recipientCount: number }>(`/api/v1/email/campaigns/${id}`, { method: "GET" }).catch(() => null);
    setCount(res?.data?.recipientCount ?? 0);
  }

  async function send() {
    const ok = await submit(() => apiClient(`/api/v1/email/campaigns/${id}/send`, { method: "POST" }), {});
    if (ok) { setOpen(false); router.refresh(); }
  }

  return (
    <>
      <Button variant="primary" size="sm" onClick={openModal}>Send</Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Send "${name}"?`} width="max-w-md">
        <div className="space-y-3">
          <p className="text-sm text-content-secondary">
            {count == null ? "Counting recipients…" : `This will email ${count} customer${count === 1 ? "" : "s"} who match the campaign and have not unsubscribed. It cannot be undone.`}
          </p>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button variant="primary" disabled={busy || count === 0} onClick={() => void send()}>
              {busy ? "Sending…" : "Send now"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
