import type { Metadata, Viewport } from "next";

import { ThemeScript } from "@/components/theme-toggle";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Raut — One Platform. Every Mile.",
    template: "%s · Raut",
  },
  description:
    "Multi-tenant ERP, CRM and field-sales management — Tari Africa Platforms Limited",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F6F8FB" },
    { media: "(prefers-color-scheme: dark)", color: "#050B1C" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // suppressHydrationWarning because ThemeScript sets the `dark` class on the
  // html element before React hydrates; without it every load logs a mismatch.
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
