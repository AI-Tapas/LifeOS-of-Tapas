"use client";

// The portfolio dashboard at the top of Money (16 Oct 2026): net worth,
// allocation by asset class, every line of the portfolio the way his own
// sheet reads it, and mutual funds by SEBI category. All numbers come from
// lib/money/portfolio.ts; this file only draws them.
//
// Reference-only holdings never reach it: portfolio() drops them first.

import { useState } from "react";
import { formatDateIST, formatINR } from "@/lib/datetime";
import { dashboard, type Holding } from "@/lib/money/investments";
import {
  ASSET_CLASS_LABELS,
  holdersOf,
  portfolio,
  type AllocationSlice,
  type AssetClass,
  type HolderView,
} from "@/lib/money/portfolio";

const SLICE_COLOR: Record<AllocationSlice["key"], string> = {
  equity: "var(--viz-equity)",
  debt: "var(--viz-debt)",
  gold: "var(--viz-gold)",
};

// Asset-class chips: text stays in ink, a coloured dot carries identity.
const CLASS_DOT: Record<AssetClass, string> = {
  equity: "var(--viz-equity)",
  debt: "var(--viz-debt)",
  gold: "var(--viz-gold)",
  hybrid: "linear-gradient(90deg, var(--viz-equity) 50%, var(--viz-debt) 50%)",
};

const cardCls =
  "rounded-2xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]";

// Lakh and crore, the way an Indian portfolio app shows a big figure.
function compactINR(n: number): string {
  if (Math.abs(n) >= 1e7) return `₹ ${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹ ${(n / 1e5).toFixed(2)} L`;
  return formatINR(Math.round(n));
}

const pctLabel = (n: number) => `${n < 10 && n > 0 ? n.toFixed(1) : Math.round(n)}%`;

function dateLabel(key: string): string {
  return formatDateIST(`${key}T12:00:00+05:30`);
}

export default function PortfolioDashboard({
  holdings,
  todayKey,
}: {
  holdings: Holding[];
  todayKey: string;
}) {
  const [view, setView] = useState<HolderView>("all");
  const holders = holdersOf(holdings);
  const p = portfolio(holdings, view);
  const due = dashboard(holdings, todayKey);
  const views: { key: HolderView; label: string }[] = [
    { key: "all", label: "Everyone" },
    { key: "you", label: "You" },
    ...holders.map((h) => ({ key: h, label: h })),
  ];

  return (
    <div className="mt-4 space-y-3">
      {holders.length > 0 && (
        <div
          role="tablist"
          aria-label="Whose portfolio"
          className="flex gap-1 overflow-x-auto rounded-xl bg-surface-2 p-1"
        >
          {views.map((v) => (
            <button
              key={v.key}
              role="tab"
              aria-selected={view === v.key}
              onClick={() => setView(v.key)}
              className={
                "press min-h-9 flex-1 whitespace-nowrap rounded-lg px-3 text-sm font-medium " +
                (view === v.key
                  ? "bg-surface text-foreground shadow-[var(--shadow-card)]"
                  : "text-secondary")
              }
            >
              {v.label}
            </button>
          ))}
        </div>
      )}

      {/* Hero: the one number, then what it is made of. */}
      <div className={cardCls + " bg-gradient-to-br from-surface to-accent-soft"}>
        <p className="text-xs font-semibold uppercase tracking-wider text-secondary">
          Net worth
        </p>
        <p className="mt-1 font-serif text-[40px] font-medium leading-none tracking-tight">
          {compactINR(p.total)}
        </p>
        <p className="mt-1 text-sm text-secondary tabular-nums">{formatINR(Math.round(p.total))}</p>
        <div className="mt-4 grid grid-cols-3 gap-2 border-t border-border pt-3">
          <Stat label="Equity share" value={pctLabel(p.equity_pct)} />
          <Stat label="Holdings" value={String(p.count)} />
          {p.invested > 0 ? (
            <Stat
              label="Gain"
              value={`${p.gain >= 0 ? "▲" : "▼"} ${compactINR(Math.abs(p.gain))}`}
              hint={`on ${compactINR(p.invested)} where cost is known`}
              tone={p.gain >= 0 ? "ok" : "overdue"}
            />
          ) : (
            <Stat label="Gain" value="Not known" hint="add invested amounts" />
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className={cardCls}>
          <p className="text-sm font-semibold">Asset allocation</p>
          <div className="mt-3 flex items-center gap-5">
            <Donut slices={p.allocation} equityPct={p.equity_pct} />
            <ul className="min-w-0 flex-1 space-y-2.5">
              {p.allocation.map((s) => (
                <li key={s.key}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="flex items-center gap-2 text-sm">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: SLICE_COLOR[s.key] }}
                      />
                      {s.label}
                    </span>
                    <span className="text-sm font-semibold tabular-nums">
                      {pctLabel(s.share)}
                    </span>
                  </div>
                  <p className="pl-[18px] text-xs text-secondary tabular-nums">
                    {compactINR(s.value)}
                  </p>
                </li>
              ))}
            </ul>
          </div>
          <p className="mt-3 text-xs text-muted">
            Hybrid holdings (NPS, hybrid funds) are split by their equity share.
          </p>
        </div>

        <div className={cardCls}>
          <p className="text-sm font-semibold">Coming up</p>
          <p className="mt-2 text-xs font-medium text-secondary">Maturing in the next 90 days</p>
          {due.maturing.length ? (
            <ul className="mt-1 divide-y divide-border">
              {due.maturing.map((m) => (
                <li key={m.id} className="flex items-baseline justify-between gap-2 py-1.5">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{m.label}</span>
                    <span className="text-xs text-secondary">{dateLabel(m.key_date)}</span>
                  </span>
                  {m.value != null && (
                    <span className="shrink-0 text-sm tabular-nums">{compactINR(m.value)}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-0.5 text-sm text-secondary">Nothing maturing.</p>
          )}
          <p className="mt-3 text-xs font-medium text-secondary">Due for review</p>
          {due.reviews.length ? (
            <ul className="mt-1 divide-y divide-border">
              {due.reviews.map((r) => (
                <li key={r.id} className="py-1.5 text-sm">
                  {r.name}
                  <span className={r.overdue ? "text-overdue" : "text-secondary"}>
                    {" "}· {dateLabel(r.key_date)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-0.5 text-sm text-secondary">Nothing in the next two weeks.</p>
          )}
        </div>
      </div>

      {/* His sheet, as a table: what it is, its class, equity share, amount, share. */}
      <div className={cardCls + " p-0"}>
        <div className="flex items-baseline justify-between px-4 pt-4">
          <p className="text-sm font-semibold">Portfolio</p>
          <p className="text-xs text-muted">% of {compactINR(p.total)}</p>
        </div>
        <div className="mt-2 hidden grid-cols-[1fr_110px_70px_120px_70px] gap-3 border-b border-border px-4 pb-2 text-xs font-medium text-muted md:grid">
          <span>Investment</span>
          <span>Category</span>
          <span className="text-right">Equity</span>
          <span className="text-right">Amount</span>
          <span className="text-right">Share</span>
        </div>
        <ul className="divide-y divide-border">
          {p.lines.map((l) => (
            <li key={l.key} className="px-4 py-3">
              <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-3 md:grid-cols-[1fr_110px_70px_120px_70px]">
                <span className="min-w-0">
                  <span className="text-sm font-medium">{l.label}</span>
                  {(l.holder || l.count > 1) && (
                    <span className="text-xs text-secondary">
                      {" "}
                      {[l.holder, l.count > 1 ? `${l.count} holdings` : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  )}
                </span>
                <span className="text-right text-sm font-semibold tabular-nums md:order-4">
                  {formatINR(Math.round(l.value))}
                </span>
                <span className="mt-1 flex items-center gap-1.5 text-xs text-secondary md:order-2 md:mt-0">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: CLASS_DOT[l.asset_class] }}
                  />
                  {ASSET_CLASS_LABELS[l.asset_class]}
                  <span className="md:hidden"> · {l.equity_pct}% equity</span>
                </span>
                <span className="mt-1 text-right text-xs text-secondary tabular-nums md:order-5 md:mt-0 md:text-sm md:text-foreground">
                  {pctLabel(l.share)}
                </span>
                <span className="hidden text-right text-sm tabular-nums text-secondary md:order-3 md:block">
                  {l.equity_pct}%
                </span>
              </div>
              <div className="mt-2 h-1 rounded-full bg-surface-2">
                <div
                  className="h-1 rounded-full bg-accent"
                  style={{ width: `${Math.max(l.share, 0.5)}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      </div>

      {p.funds_total > 0 && (
        <div className={cardCls}>
          <div className="flex items-baseline justify-between">
            <p className="text-sm font-semibold">Mutual funds by category</p>
            <p className="text-sm font-semibold tabular-nums">{compactINR(p.funds_total)}</p>
          </div>
          {p.uncategorised > 0 && (
            <p className="mt-1 text-xs text-today">
              {p.uncategorised} {p.uncategorised === 1 ? "fund has" : "funds have"} no
              category yet and count as equity.
            </p>
          )}
          <ul className="mt-3 space-y-1">
            {p.categories.map((c) => (
              <li key={c.key}>
                <details className="group rounded-lg">
                  <summary className="press flex cursor-pointer list-none flex-col gap-1.5 rounded-lg px-1 py-2 hover:bg-surface-2">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="flex items-center gap-2 text-sm">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ background: CLASS_DOT[c.asset_class] }}
                        />
                        {c.label}
                        <span className="text-xs text-muted">· {c.funds.length}</span>
                      </span>
                      <span className="text-sm tabular-nums">
                        <span className="font-semibold">{compactINR(c.value)}</span>
                        <span className="ml-2 inline-block w-11 text-right text-secondary">
                          {pctLabel(c.share)}
                        </span>
                      </span>
                    </span>
                    <span className="h-1.5 rounded-full bg-surface-2">
                      <span
                        className="block h-1.5 rounded-full"
                        style={{
                          width: `${Math.max(c.share, 0.5)}%`,
                          background: CLASS_DOT[c.asset_class],
                        }}
                      />
                    </span>
                  </summary>
                  <ul className="mb-2 ml-4 border-l border-border pl-3">
                    {c.funds.map((f) => (
                      <li key={f.id} className="flex items-baseline justify-between gap-2 py-1">
                        <span className="min-w-0 text-sm">
                          {f.name}
                          {f.holder && (
                            <span className="ml-1 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-secondary">
                              {f.holder}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-sm tabular-nums text-secondary">
                          {formatINR(Math.round(f.value))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "ok" | "overdue";
}) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</p>
      <p
        className={
          "mt-0.5 truncate text-base font-semibold tabular-nums " +
          (tone === "ok" ? "text-ok" : tone === "overdue" ? "text-overdue" : "")
        }
      >
        {value}
      </p>
      {hint && <p className="truncate text-[11px] text-secondary">{hint}</p>}
    </div>
  );
}

// A ring, one arc per slice with a 2px surface gap, and the equity share in
// the middle. Each arc has a native tooltip; the legend beside it carries
// every value, so nothing is colour alone.
function Donut({ slices, equityPct }: { slices: AllocationSlice[]; equityPct: number }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const gap = slices.length > 1 ? 2 : 0;
  // Where each arc starts, worked out before drawing.
  const starts = slices.map((_, i) =>
    slices.slice(0, i).reduce((sum, s) => sum + (s.share / 100) * c, 0)
  );
  return (
    <svg viewBox="0 0 100 100" className="h-32 w-32 shrink-0 -rotate-90" role="img"
      aria-label={slices.map((s) => `${s.label} ${Math.round(s.share)}%`).join(", ")}>
      <circle cx="50" cy="50" r={r} fill="none" stroke="var(--surface-2)" strokeWidth="12" />
      {slices.map((s, i) => {
        const len = Math.max((s.share / 100) * c - gap, 0.5);
        return (
          <circle
            key={s.key}
            cx="50"
            cy="50"
            r={r}
            fill="none"
            stroke={SLICE_COLOR[s.key]}
            strokeWidth="12"
            strokeDasharray={`${len} ${c - len}`}
            strokeDashoffset={-starts[i]}
          >
            <title>{`${s.label}: ${formatINR(Math.round(s.value))} (${pctLabel(s.share)})`}</title>
          </circle>
        );
      })}
      <g className="rotate-90" style={{ transformOrigin: "50px 50px" }}>
        <text x="50" y="49" textAnchor="middle" className="fill-foreground text-[15px] font-semibold">
          {Math.round(equityPct)}%
        </text>
        <text x="50" y="62" textAnchor="middle" className="fill-[var(--text-muted)] text-[8px]">
          equity
        </text>
      </g>
    </svg>
  );
}
