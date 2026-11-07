import Link from "next/link";
import type { ReactNode } from "react";

import { RautWordmark } from "@/components/raut-mark";
import { ORGANISATION_NAME } from "@/lib/seo";

const LINKS = [
  { href: "/gps-trackers", label: "GPS trackers & SIMs" },
  { href: "/blog", label: "Blog" },
  { href: "/contact-us", label: "Contact" },
];

/** The header and footer every public page shares. */
export function PublicChrome({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-20 border-b border-border bg-surface">
        <nav aria-label="Main" className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <Link href="/" aria-label="Raut home">
            <RautWordmark compact />
          </Link>
          <div className="flex items-center gap-4 text-sm sm:gap-5">
            {LINKS.map((link) => (
              <Link key={link.href} href={link.href} className="hidden text-content-secondary hover:text-accent sm:inline">
                {link.label}
              </Link>
            ))}
            <Link href="/blog" className="text-content-secondary hover:text-accent sm:hidden">
              Blog
            </Link>
            <Link href="/login" className="rounded-lg bg-accent px-4 py-2 font-medium text-white hover:bg-accent-hover">
              Sign in
            </Link>
          </div>
        </nav>
        <div className="afr-band" aria-hidden="true" />
      </header>

      <main id="content" className="flex-1">
        {children}
      </main>

      <footer className="afr-weave-dark bg-ink-950 text-white">
        <div className="afr-band" aria-hidden="true" />
        <div className="mx-auto grid max-w-6xl gap-8 px-6 py-10 sm:grid-cols-3">
          <div>
            <p className="font-display text-lg font-semibold">Raut</p>
            <p className="mt-1 text-sm text-white/70">{ORGANISATION_NAME}</p>
            <p className="text-sm text-white/70">Nairobi, Kenya</p>
          </div>
          <nav aria-label="Products" className="text-sm">
            <p className="mb-2 font-semibold">Products</p>
            <ul className="space-y-1.5">
              <li><Link href="/gps-trackers" className="text-white/80 hover:text-white">GPS trackers and SIM cards</Link></li>
              <li><Link href="/" className="text-white/80 hover:text-white">Raut business platform</Link></li>
            </ul>
          </nav>
          <nav aria-label="Company" className="text-sm">
            <p className="mb-2 font-semibold">Company</p>
            <ul className="space-y-1.5">
              <li><Link href="/blog" className="text-white/80 hover:text-white">Logistics blog</Link></li>
              <li><Link href="/contact-us" className="text-white/80 hover:text-white">Contact us</Link></li>
              <li><Link href="/policy" className="text-white/80 hover:text-white">Privacy and cookies</Link></li>
            </ul>
          </nav>
        </div>
      </footer>
    </div>
  );
}
