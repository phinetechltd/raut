"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { apiClient, useFormSubmit, Button, ModalButton, Textarea } from "@/components/ui";

/** Send box inside a conversation. repId is omitted when the sender is the rep. */
export function MessageComposer({ repId }: { repId?: string }) {
  const router = useRouter();
  const { busy, error, submit } = useFormSubmit();
  const [body, setBody] = useState("");

  async function send() {
    if (!body.trim()) return;
    const ok = await submit(
      () => apiClient("/api/v1/messages", { method: "POST", body: { repId: repId ?? null, body } }),
      {},
    );
    if (ok) {
      setBody("");
      router.refresh();
    }
  }

  return (
    <div className="border-t border-border p-3">
      <div className="flex items-end gap-2">
        <Textarea
          rows={2}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write a message…"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Button variant="primary" disabled={busy || !body.trim()} onClick={() => void send()}>
          {busy ? "Sending…" : "Send"}
        </Button>
      </div>
      {error ? <p className="mt-1 text-sm text-danger">{error}</p> : null}
      <p className="mt-1 text-[11px] text-content-muted">Ctrl/⌘ + Enter to send</p>
    </div>
  );
}

export function BroadcastDialog() {
  return (
    <ModalButton label="Broadcast" title="Broadcast to all reps" description="Sends one message into every field rep's thread." width="max-w-md" variant="secondary">
      {(close) => <BroadcastForm onClose={close} />}
    </ModalButton>
  );
}

function BroadcastForm({ onClose }: { onClose: (saved: boolean) => void }) {
  const router = useRouter();
  const { busy, error, submit } = useFormSubmit();
  const [body, setBody] = useState("");

  async function send() {
    const ok = await submit(() => apiClient("/api/v1/messages/broadcast", { method: "POST", body: { body } }), {});
    if (ok) {
      onClose(true);
      router.refresh();
    }
  }

  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Message to every field rep…" required />
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !body.trim()}>{busy ? "Sending…" : "Send to all reps"}</Button>
      </div>
    </form>
  );
}
