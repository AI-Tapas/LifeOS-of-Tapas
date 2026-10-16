// The portfolio view of Money (16 Oct 2026): every holding in an asset class
// with its share of equity, grouped the way Tapas keeps his own sheet ("Mom
// fixed deposits | Debt | 0% | amount | % of portfolio"), plus mutual funds
// split by their SEBI category. Pure, so the dashboard and scripts/m7b.test.ts
// read the same numbers.
//
// The asset class is DERIVED: from the kind, and for a fund from its category.
// Only two things are stored per holding: the fund category, and an equity
// share override where the default is wrong (NPS on active choice).
import { KIND_LABELS, managedHoldings, type FinanceKind, type Holding } from "./investments.ts";

export type AssetClass = "equity" | "debt" | "hybrid" | "gold";

export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  equity: "Equity",
  debt: "Debt",
  hybrid: "Hybrid",
  gold: "Gold",
};

export interface FundCategory {
  label: string;
  asset_class: AssetClass;
  equity: number; // default share in equity, 0 to 100
}

// SEBI categories, in the order the dashboard lists them. Hybrid equity
// shares are typical, not exact; equity_pct on the holding overrides one.
export const FUND_CATEGORIES: Record<string, FundCategory> = {
  large_cap: { label: "Large cap", asset_class: "equity", equity: 100 },
  large_mid_cap: { label: "Large and mid cap", asset_class: "equity", equity: 100 },
  flexi_cap: { label: "Flexi cap", asset_class: "equity", equity: 100 },
  multi_cap: { label: "Multi cap", asset_class: "equity", equity: 100 },
  mid_cap: { label: "Mid cap", asset_class: "equity", equity: 100 },
  small_cap: { label: "Small cap", asset_class: "equity", equity: 100 },
  value: { label: "Value", asset_class: "equity", equity: 100 },
  focused: { label: "Focused", asset_class: "equity", equity: 100 },
  elss: { label: "ELSS (tax saver)", asset_class: "equity", equity: 100 },
  sectoral: { label: "Sectoral or thematic", asset_class: "equity", equity: 100 },
  index_large: { label: "Index, large cap", asset_class: "equity", equity: 100 },
  index_mid: { label: "Index, mid cap", asset_class: "equity", equity: 100 },
  index_small: { label: "Index, small cap", asset_class: "equity", equity: 100 },
  international: { label: "International", asset_class: "equity", equity: 100 },
  aggressive_hybrid: { label: "Aggressive hybrid", asset_class: "hybrid", equity: 75 },
  balanced_advantage: { label: "Balanced advantage", asset_class: "hybrid", equity: 50 },
  multi_asset: { label: "Multi asset", asset_class: "hybrid", equity: 50 },
  equity_savings: { label: "Equity savings", asset_class: "hybrid", equity: 30 },
  arbitrage: { label: "Arbitrage", asset_class: "hybrid", equity: 0 },
  liquid: { label: "Liquid", asset_class: "debt", equity: 0 },
  overnight: { label: "Overnight", asset_class: "debt", equity: 0 },
  money_market: { label: "Money market", asset_class: "debt", equity: 0 },
  ultra_short: { label: "Ultra short duration", asset_class: "debt", equity: 0 },
  low_duration: { label: "Low duration", asset_class: "debt", equity: 0 },
  short_duration: { label: "Short duration", asset_class: "debt", equity: 0 },
  corporate_bond: { label: "Corporate bond", asset_class: "debt", equity: 0 },
  banking_psu: { label: "Banking and PSU", asset_class: "debt", equity: 0 },
  gilt: { label: "Gilt", asset_class: "debt", equity: 0 },
  dynamic_bond: { label: "Dynamic bond", asset_class: "debt", equity: 0 },
  gold_fund: { label: "Gold fund", asset_class: "gold", equity: 0 },
};

export const FUND_CATEGORY_KEYS = Object.keys(FUND_CATEGORIES);

export function isFundCategory(v: unknown): v is string {
  return typeof v === "string" && v in FUND_CATEGORIES;
}

// NPS on active choice is mostly equity; 75 matches his own sheet. The
// holding's equity_pct overrides it (his NPS is 70% scheme E).
const KIND_CLASS: Record<FinanceKind, { asset_class: AssetClass; equity: number }> = {
  fd: { asset_class: "debt", equity: 0 },
  ncd: { asset_class: "debt", equity: 0 },
  ppf: { asset_class: "debt", equity: 0 },
  epf: { asset_class: "debt", equity: 0 },
  ssy: { asset_class: "debt", equity: 0 },
  savings: { asset_class: "debt", equity: 0 },
  stock: { asset_class: "equity", equity: 100 },
  nps: { asset_class: "hybrid", equity: 75 },
  gold: { asset_class: "gold", equity: 0 },
  // A fund with no category yet counts as equity: most of his funds are, and
  // the dashboard names how many are uncategorised so it is never silent.
  mf: { asset_class: "equity", equity: 100 },
  other: { asset_class: "debt", equity: 0 },
};

export function assetClass(h: Holding): AssetClass {
  if (h.kind === "mf" && isFundCategory(h.fund_category)) {
    return FUND_CATEGORIES[h.fund_category].asset_class;
  }
  return KIND_CLASS[h.kind].asset_class;
}

export function equityShare(h: Holding): number {
  if (h.equity_pct != null) return Number(h.equity_pct);
  if (h.kind === "mf" && isFundCategory(h.fund_category)) {
    return FUND_CATEGORIES[h.fund_category].equity;
  }
  return KIND_CLASS[h.kind].equity;
}

// ---------------------------------------------------------------------------

// Which holdings a view shows. "all" is every managed holder together;
// "you" is his own; anything else is a holder label. Reference-only holdings
// never appear in any view.
export type HolderView = "all" | "you" | string;

export function holdersOf(items: Holding[]): string[] {
  const seen = new Map<string, string>();
  for (const h of managedHoldings(items)) {
    const label = h.held_for?.trim();
    if (label && !seen.has(label.toLowerCase())) seen.set(label.toLowerCase(), label);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

export function inView(items: Holding[], view: HolderView): Holding[] {
  const managed = managedHoldings(items);
  if (view === "all") return managed;
  if (view === "you") return managed.filter((h) => !h.held_for?.trim());
  const want = view.trim().toLowerCase();
  return managed.filter((h) => h.held_for?.trim().toLowerCase() === want);
}

export interface PortfolioLine {
  key: string;
  label: string;
  holder: string | null;
  asset_class: AssetClass;
  equity_pct: number;
  value: number;
  share: number; // of the view's total, 0 to 100
  count: number;
}

export interface AllocationSlice {
  key: "equity" | "debt" | "gold";
  label: string;
  value: number;
  share: number;
}

export interface CategoryRow {
  key: string;
  label: string;
  asset_class: AssetClass;
  value: number;
  share: number; // of all mutual funds in the view
  funds: { id: string; name: string; holder: string | null; value: number }[];
}

export interface Portfolio {
  total: number;
  count: number;
  invested: number; // over the holdings that carry an invested amount
  invested_value: number; // their current value
  gain: number;
  equity_pct: number; // of the whole view
  allocation: AllocationSlice[];
  lines: PortfolioLine[];
  funds_total: number;
  categories: CategoryRow[];
  uncategorised: number;
}

const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
const value = (h: Holding) => Number(h.value ?? 0);

// One line per kind and holder, like his sheet: "Fixed deposits, Mother".
// A line whose holdings span classes reads Hybrid with its weighted equity.
export function portfolio(items: Holding[], view: HolderView): Portfolio {
  const hs = inView(items, view);
  const total = hs.reduce((s, h) => s + value(h), 0);
  const equity = hs.reduce((s, h) => s + (value(h) * equityShare(h)) / 100, 0);
  const gold = hs
    .filter((h) => assetClass(h) === "gold")
    .reduce((s, h) => s + value(h), 0);
  const debt = total - equity - gold;

  const lineMap = new Map<string, Holding[]>();
  for (const h of hs) {
    const key = `${h.kind}|${h.held_for?.trim().toLowerCase() ?? ""}`;
    lineMap.set(key, [...(lineMap.get(key) ?? []), h]);
  }
  const lines: PortfolioLine[] = [...lineMap.entries()].map(([key, group]) => {
    const v = group.reduce((s, h) => s + value(h), 0);
    const eq = group.reduce((s, h) => s + (value(h) * equityShare(h)) / 100, 0);
    const classes = new Set(group.map(assetClass));
    return {
      key,
      // Named by what it is ("PPF", "Fixed deposits"); only "other" keeps
      // the holding's own name, since its kind says nothing.
      label:
        group[0].kind !== "other"
          ? pluralKind(group[0].kind)
          : group.length > 1
            ? "Other"
            : group[0].name,
      holder: group[0].held_for?.trim() || null,
      // A mixed line reads by what it mostly is: 99% equity funds with a
      // little liquid money is still equity, not "hybrid".
      asset_class:
        classes.size === 1
          ? [...classes][0]
          : pct(eq, v) >= 80
            ? "equity"
            : pct(eq, v) <= 20
              ? "debt"
              : "hybrid",
      equity_pct: Math.round(pct(eq, v)),
      value: v,
      share: pct(v, total),
      count: group.length,
    };
  });
  lines.sort((a, b) => b.value - a.value);

  const funds = hs.filter((h) => h.kind === "mf");
  const fundsTotal = funds.reduce((s, h) => s + value(h), 0);
  const catMap = new Map<string, Holding[]>();
  for (const f of funds) {
    const key = isFundCategory(f.fund_category) ? f.fund_category : "uncategorised";
    catMap.set(key, [...(catMap.get(key) ?? []), f]);
  }
  const categories: CategoryRow[] = [...catMap.entries()]
    .map(([key, group]) => {
      const v = group.reduce((s, h) => s + value(h), 0);
      const cat = FUND_CATEGORIES[key];
      return {
        key,
        label: cat?.label ?? "Not categorised yet",
        asset_class: cat?.asset_class ?? "equity",
        value: v,
        share: pct(v, fundsTotal),
        funds: group
          .map((h) => ({ id: h.id, name: h.name, holder: h.held_for?.trim() || null, value: value(h) }))
          .sort((a, b) => b.value - a.value),
      };
    })
    .sort((a, b) => b.value - a.value);

  const withCost = hs.filter((h) => h.invested != null && h.value != null);
  const invested = withCost.reduce((s, h) => s + Number(h.invested), 0);
  const investedValue = withCost.reduce((s, h) => s + value(h), 0);

  return {
    total,
    count: hs.length,
    invested,
    invested_value: investedValue,
    gain: investedValue - invested,
    equity_pct: pct(equity, total),
    allocation: (
      [
        { key: "equity", label: "Equity", value: equity, share: pct(equity, total) },
        { key: "debt", label: "Debt", value: debt, share: pct(debt, total) },
        { key: "gold", label: "Gold", value: gold, share: pct(gold, total) },
      ] as AllocationSlice[]
    ).filter((s) => s.value > 0),
    lines,
    funds_total: fundsTotal,
    categories,
    uncategorised: catMap.get("uncategorised")?.length ?? 0,
  };
}

function pluralKind(kind: FinanceKind): string {
  const plural: Partial<Record<FinanceKind, string>> = {
    fd: "Fixed deposits",
    mf: "Mutual funds",
    stock: "Stocks",
    ncd: "NCDs",
    gold: "Gold",
  };
  return plural[kind] ?? KIND_LABELS[kind];
}
