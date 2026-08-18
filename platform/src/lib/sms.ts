import "server-only";

import { db } from "./db";
import { formatKES } from "./money";

/**
 * Module 09 · SMS Communication.
 *
 * The proposal excludes a live bulk-SMS account from the platform price
 * (§5, p.11: "SMS Providers … quoted separately"). So this ships with a
 * `console` adapter that records messages without sending them, plus the
 * provider interface an Africa's Talking or Twilio account plugs into later.
 *
 * Messages are always persisted first and dispatched second, so a provider
 * outage leaves a queue to retry rather than lost notifications.
 */

export type SmsTemplateKey =
  | "ORDER_CONFIRMATION"
  | "PAYMENT_RECEIPT"
  | "BALANCE_REMINDER"
  | "PROMOTION"
  | "VISIT_REMINDER";

export const DEFAULT_TEMPLATES: Array<{
  key: SmsTemplateKey;
  name: string;
  body: string;
}> = [
  {
    key: "ORDER_CONFIRMATION",
    name: "Order confirmation",
    body: "Hi {{customer}}, we have received your order {{number}} for {{amount}}. Thank you for your business. {{company}}",
  },
  {
    key: "PAYMENT_RECEIPT",
    name: "Payment receipt",
    body: "Hi {{customer}}, we confirm payment of {{amount}} received on {{date}}. Your balance is now {{balance}}. {{company}}",
  },
  {
    key: "BALANCE_REMINDER",
    name: "Balance reminder",
    body: "Dear {{customer}}, your account balance of {{balance}} is due on {{date}}. Kindly arrange payment. {{company}}",
  },
  {
    key: "PROMOTION",
    name: "Promotion",
    body: "Hi {{customer}}, {{message}} {{company}}",
  },
  {
    key: "VISIT_REMINDER",
    name: "Visit reminder",
    body: "Hi {{customer}}, our rep {{rep}} will visit you on {{date}}. {{company}}",
  },
];

export interface SmsProvider {
  readonly name: string;
  send(to: string, body: string, senderId: string): Promise<{
    ok: boolean;
    providerRef?: string;
    costCents?: number;
    error?: string;
  }>;
}

/** Development / unlicensed-provider adapter: records, does not transmit. */
const consoleProvider: SmsProvider = {
  name: "console",
  async send(to, body) {
    console.info(`[sms:console] → ${to}: ${body}`);
    return { ok: true, providerRef: `console-${Date.now()}`, costCents: 0 };
  },
};

/**
 * Africa's Talking adapter. Left unwired by default because it needs a live
 * account; supply SMS_API_KEY and SMS_API_USERNAME to activate.
 */
const africasTalkingProvider: SmsProvider = {
  name: "africastalking",
  async send(to, body, senderId) {
    const apiKey = process.env.SMS_API_KEY;
    const username = process.env.SMS_API_USERNAME;
    if (!apiKey || !username) {
      return { ok: false, error: "Africa's Talking credentials are not configured" };
    }

    try {
      const res = await fetch("https://api.africastalking.com/version1/messaging", {
        method: "POST",
        headers: {
          apiKey,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({ username, to, message: body, from: senderId }),
      });
      if (!res.ok) return { ok: false, error: `Provider returned ${res.status}` };

      const json = (await res.json()) as {
        SMSMessageData?: { Recipients?: Array<{ messageId?: string; cost?: string }> };
      };
      const recipient = json.SMSMessageData?.Recipients?.[0];
      const cost = recipient?.cost?.replace(/[^\d.]/g, "");
      return {
        ok: true,
        providerRef: recipient?.messageId,
        costCents: cost ? Math.round(Number(cost) * 100) : 0,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Send failed" };
    }
  },
};

function providerFor(name: string): SmsProvider {
  switch (name) {
    case "africastalking":
      return africasTalkingProvider;
    case "console":
    default:
      return consoleProvider;
  }
}

/** Substitutes {{placeholders}}; unknown keys collapse to empty rather than leaking braces. */
export function renderTemplate(
  body: string,
  vars: Record<string, string | number | null | undefined>,
): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
    const value = vars[key];
    return value == null ? "" : String(value);
  });
}

/**
 * Normalises Kenyan numbers to E.164. Reps type 07…, 7…, +254… and 254…
 * interchangeably; storing whichever form was typed makes deduplication and
 * delivery unreliable, so everything is canonicalised on the way in.
 */
export function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+254") && digits.length === 13) return digits;
  if (digits.startsWith("254") && digits.length === 12) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 10) return `+254${digits.slice(1)}`;
  if (digits.length === 9 && (digits.startsWith("7") || digits.startsWith("1")))
    return `+254${digits}`;
  if (digits.startsWith("+") && digits.length >= 11) return digits;
  return null;
}

export interface QueueSmsInput {
  companyId: string;
  customerId?: string | null;
  toPhone: string;
  body: string;
  templateKey?: string | null;
}

/**
 * Persists then dispatches. Returns the stored row either way — a failed send
 * stays queryable as FAILED with the provider's reason attached.
 */
export async function queueSms(input: QueueSmsInput) {
  const to = normalisePhone(input.toPhone);
  const providerName = process.env.SMS_PROVIDER ?? "console";

  const message = await db.smsMessage.create({
    data: {
      companyId: input.companyId,
      customerId: input.customerId ?? null,
      toPhone: to ?? input.toPhone,
      body: input.body,
      templateKey: input.templateKey ?? null,
      provider: providerName,
      status: to ? "QUEUED" : "FAILED",
      error: to ? null : "Unrecognised phone number format",
    },
  });

  if (!to) return message;

  const provider = providerFor(providerName);
  const result = await provider.send(to, input.body, process.env.SMS_SENDER_ID ?? "Raut");

  return db.smsMessage.update({
    where: { id: message.id },
    data: {
      status: result.ok ? "SENT" : "FAILED",
      providerRef: result.providerRef ?? null,
      costCents: result.costCents ?? 0,
      error: result.error ?? null,
      sentAt: result.ok ? new Date() : null,
    },
  });
}

/**
 * Sends a templated message, falling back to the built-in copy when a company
 * has not customised the template. Silently no-ops when the SMS module is not
 * licensed — callers are business flows (order created, payment taken) that
 * must not fail because a company skipped Module 09.
 */
export async function sendTemplated(params: {
  companyId: string;
  templateKey: SmsTemplateKey;
  customerId?: string | null;
  toPhone: string | null | undefined;
  vars: Record<string, string | number | null | undefined>;
}) {
  if (!params.toPhone) return null;

  const licensed = await db.companyModule.findUnique({
    where: { companyId_moduleKey: { companyId: params.companyId, moduleKey: "SMS" } },
    select: { enabled: true },
  });
  if (!licensed?.enabled) return null;

  const template = await db.smsTemplate.findUnique({
    where: { companyId_key: { companyId: params.companyId, key: params.templateKey } },
  });
  if (template && !template.active) return null;

  const body = template?.body ?? DEFAULT_TEMPLATES.find((t) => t.key === params.templateKey)?.body;
  if (!body) return null;

  return queueSms({
    companyId: params.companyId,
    customerId: params.customerId,
    toPhone: params.toPhone,
    body: renderTemplate(body, params.vars),
    templateKey: params.templateKey,
  });
}

/** Convenience for the money placeholders the default templates use. */
export function smsMoney(cents: number): string {
  return formatKES(cents);
}
