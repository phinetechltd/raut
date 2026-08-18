import { Money, Meter, SectionHeading, StatCard } from "@/components/ui";
import { db } from "@/lib/db";
import {
  ALL_MODULES_PRICE_CENTS,
  CORE_PLATFORM_PRICE_CENTS,
  FULL_PLATFORM_PRICE_CENTS,
  MODULE_LIST,
} from "@/lib/modules";

export const dynamic = "force-dynamic";

/** The commercial catalogue from proposal §3 and §4, with live adoption. */
export default async function ModuleCataloguePage() {
  const [companies, licences] = await Promise.all([
    db.company.count(),
    db.companyModule.groupBy({
      by: ["moduleKey"],
      where: { enabled: true },
      _count: true,
      _sum: { priceCents: true },
    }),
  ]);

  const adoption = new Map(licences.map((l) => [l.moduleKey, l._count]));
  const revenue = new Map(licences.map((l) => [l.moduleKey, l._sum.priceCents ?? 0]));
  const totalLicensed = licences.reduce((s, l) => s + (l._sum.priceCents ?? 0), 0);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Module Catalogue</h1>
        <p className="text-content-muted text-sm">
          The commercial units of the platform. Core is always included; the ten
          modules are licensed per company.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Core platform" value={<Money cents={CORE_PLATFORM_PRICE_CENTS} />} hint="Always included" />
        <StatCard label="All modules" value={<Money cents={ALL_MODULES_PRICE_CENTS} />} hint="10 modules" />
        <StatCard label="Full platform" value={<Money cents={FULL_PLATFORM_PRICE_CENTS} />} hint="Per company ceiling" />
        <StatCard
          label="Licensed across tenants"
          value={<Money cents={totalLicensed} compact />}
          hint={`${licences.reduce((s, l) => s + l._count, 0)} module licences sold`}
          tone="success"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {MODULE_LIST.map((m) => {
          const count = adoption.get(m.key) ?? 0;
          return (
            <article key={m.key} className="rounded-lg border border-border bg-surface p-5 shadow-sm">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-semibold">
                  <span className="text-content-muted mr-1.5">{m.ordinal}</span>
                  {m.name}
                </p>
                <p className="text-sm font-medium text-accent">
                  <Money cents={m.priceCents} />
                </p>
              </div>
              <p className="text-content-muted mt-1 text-xs">{m.summary}</p>

              <ul className="mt-3 space-y-1 text-xs">
                {m.features.map((f) => (
                  <li key={f} className="flex items-start gap-1.5">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-brand-500" />
                    {f}
                  </li>
                ))}
              </ul>

              {m.requires.length > 0 ? (
                <p className="text-content-muted mt-3 text-[11px]">
                  Requires: {m.requires.join(", ")}
                </p>
              ) : null}

              <div className="mt-4">
                <div className="mb-1 flex justify-between text-[11px]">
                  <span className="text-content-text-content-muted">Adoption</span>
                  <span className="text-content-text-content-muted">
                    {count}/{companies} companies · <Money cents={revenue.get(m.key) ?? 0} />
                  </span>
                </div>
                <Meter value={count} max={Math.max(companies, 1)} tone="accent" />
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
