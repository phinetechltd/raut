import "server-only";

import crypto from "node:crypto";

import nodemailer, { type Transporter } from "nodemailer";

import { db } from "./db";
import { renderTemplate } from "./sms";

/**
 * Email, the sibling of the SMS module.
 *
 * Provider-agnostic on purpose: a company sends through its own mail server over
 * SMTP today, and a dedicated provider (SES, Mailgun) can be slotted in later
 * by adding one adapter. As with SMS, every message is persisted first and
 * dispatched second, so a transport outage leaves a queue to retry rather than
 * lost mail, and the send log is the record of what actually went out.
 *
 * Bulk mail must be lawful to send: a one-click unsubscribe link is appended to
 * every campaign message, and an address that has opted out is never sent to
 * again (it is logged SKIPPED so the suppression is auditable).
 */

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  from: string;
  replyTo?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(msg: OutgoingEmail): Promise<{ ok: boolean; providerRef?: string; error?: string }>;
}

/** Development / unconfigured adapter: records, does not transmit. */
const consoleProvider: EmailProvider = {
  name: "console",
  async send(msg) {
    console.info(`[email:console] → ${msg.to}: ${msg.subject}`);
    return { ok: true, providerRef: `console-${Date.now()}` };
  },
};

let cachedTransport: Transporter | null = null;
function smtpTransport(): Transporter | null {
  if (cachedTransport) return cachedTransport;
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT ?? 587);
  // A loopback relay (the mail server on the same host) presents a certificate
  // for its public name, not 127.0.0.1, so opportunistic STARTTLS would fail
  // verification. Skip the check there only — the hop never leaves the machine.
  const isLocal = host === "127.0.0.1" || host === "localhost" || host === "::1";
  cachedTransport = nodemailer.createTransport({
    host,
    port,
    // 465 is implicit TLS; 587/25 upgrade with STARTTLS.
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" } : undefined,
    ...(isLocal ? { tls: { rejectUnauthorized: false } } : {}),
  });
  return cachedTransport;
}

const smtpProvider: EmailProvider = {
  name: "smtp",
  async send(msg) {
    const transport = smtpTransport();
    if (!transport) return { ok: false, error: "SMTP is not configured (set SMTP_HOST)" };
    try {
      const info = await transport.sendMail({
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        replyTo: msg.replyTo,
      });
      return { ok: true, providerRef: info.messageId };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Send failed" };
    }
  },
};

function providerName(): string {
  return process.env.EMAIL_PROVIDER ?? (process.env.SMTP_HOST ? "smtp" : "console");
}
function providerFor(name: string): EmailProvider {
  return name === "smtp" ? smtpProvider : consoleProvider;
}

/** RFC-lite address check — enough to keep obviously bad input out of the queue. */
export function isValidEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
}

// ── unsubscribe ──────────────────────────────────────────────────────────

function unsubSecret(): string {
  return process.env.EMAIL_UNSUBSCRIBE_SECRET ?? process.env.AUTH_SECRET ?? "raut-dev-unsubscribe-secret";
}

/** A tamper-proof token binding an address to a company, so the public
 *  unsubscribe link cannot be used to opt out arbitrary third parties. */
export function unsubscribeToken(companyId: string, email: string): string {
  return crypto.createHmac("sha256", unsubSecret()).update(`${companyId}:${email.toLowerCase()}`).digest("hex").slice(0, 32);
}

export function verifyUnsubscribeToken(companyId: string, email: string, token: string): boolean {
  const expected = unsubscribeToken(companyId, email);
  // Constant-time compare on equal-length hex strings.
  return token.length === expected.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

function baseUrl(): string {
  return (process.env.PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "https://raut.co.ke").replace(/\/$/, "");
}

export function unsubscribeUrl(companyId: string, email: string): string {
  const q = new URLSearchParams({ c: companyId, e: email, t: unsubscribeToken(companyId, email) });
  return `${baseUrl()}/email/unsubscribe?${q.toString()}`;
}

export async function isUnsubscribed(companyId: string, email: string): Promise<boolean> {
  const row = await db.emailUnsubscribe.findUnique({
    where: { companyId_email: { companyId, email: email.toLowerCase() } },
    select: { id: true },
  });
  return !!row;
}

/** Appends a plain, unmissable unsubscribe footer to a campaign body. */
export function withUnsubscribeFooter(html: string, companyId: string, email: string): string {
  const url = unsubscribeUrl(companyId, email);
  return `${html}
    <hr style="margin-top:24px;border:none;border-top:1px solid #e5e5e5" />
    <p style="font-size:12px;color:#888;margin-top:12px">
      You are receiving this because you are a customer.
      <a href="${url}" style="color:#888">Unsubscribe from these emails</a>.
    </p>`;
}

// ── sending ──────────────────────────────────────────────────────────────

function senderFor(company: { name: string; email: string | null }): { from: string; replyTo?: string } {
  const configured = process.env.EMAIL_FROM;
  if (configured) return { from: configured, replyTo: company.email ?? undefined };
  // Fall back to a no-reply on the platform domain, replying to the company.
  const domain = baseUrl().replace(/^https?:\/\//, "");
  return { from: `${company.name} <no-reply@${domain}>`, replyTo: company.email ?? undefined };
}

export interface QueueEmailInput {
  companyId: string;
  customerId?: string | null;
  campaignId?: string | null;
  toEmail: string;
  subject: string;
  html: string;
  /** Campaign mail honours the unsubscribe list and gets the footer. */
  bulk?: boolean;
}

/**
 * Persists then dispatches one email. Returns the stored row either way, so a
 * failed or suppressed send stays queryable with its reason.
 */
export async function queueEmail(input: QueueEmailInput) {
  const company = await db.company.findUniqueOrThrow({
    where: { id: input.companyId },
    select: { name: true, email: true },
  });
  const to = input.toEmail.trim().toLowerCase();
  const provider = providerName();

  if (!isValidEmail(to)) {
    return db.emailMessage.create({
      data: { companyId: input.companyId, customerId: input.customerId ?? null, campaignId: input.campaignId ?? null, toEmail: input.toEmail, subject: input.subject, bodyHtml: input.html, provider, status: "FAILED", error: "Invalid email address" },
    });
  }

  if (input.bulk && (await isUnsubscribed(input.companyId, to))) {
    return db.emailMessage.create({
      data: { companyId: input.companyId, customerId: input.customerId ?? null, campaignId: input.campaignId ?? null, toEmail: to, subject: input.subject, bodyHtml: input.html, provider, status: "SKIPPED", error: "Recipient has unsubscribed" },
    });
  }

  const html = input.bulk ? withUnsubscribeFooter(input.html, input.companyId, to) : input.html;
  const { from, replyTo } = senderFor(company);

  const message = await db.emailMessage.create({
    data: { companyId: input.companyId, customerId: input.customerId ?? null, campaignId: input.campaignId ?? null, toEmail: to, subject: input.subject, bodyHtml: html, provider, status: "QUEUED" },
  });

  const result = await providerFor(provider).send({ to, subject: input.subject, html, from, replyTo });

  return db.emailMessage.update({
    where: { id: message.id },
    data: {
      status: result.ok ? "SENT" : "FAILED",
      providerRef: result.providerRef ?? null,
      error: result.error ?? null,
      sentAt: result.ok ? new Date() : null,
    },
  });
}

export { renderTemplate };
