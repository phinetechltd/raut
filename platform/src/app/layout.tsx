import type { Metadata, Viewport } from "next";
import { Fraunces } from "next/font/google";

import { ThemeScript } from "@/components/theme-toggle";
import { jsonLd, organisationSchema, siteUrl, websiteSchema } from "@/lib/seo";

import "./globals.css";

/** A warm, characterful display serif for headlines. Body text stays on the system sans. */
const display = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  applicationName: "Raut",
  title: {
    default: "Raut — One Platform. Every Mile.",
    template: "%s · Raut",
  },
  description:
    "Multi-tenant ERP, CRM and field-sales management — Tari Africa Platforms Limited",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FAF6EF" },
    { media: "(prefers-color-scheme: dark)", color: "#120E0A" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // suppressHydrationWarning because ThemeScript sets the `dark` class on the
  // html element before React hydrates; without it every load logs a mismatch.
  return (
    <html lang="en-KE" className={display.variable} suppressHydrationWarning>
      <head>
        <ThemeScript />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(organisationSchema()) }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(websiteSchema()) }} />
      </head>
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
