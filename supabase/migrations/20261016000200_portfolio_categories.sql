-- Portfolio categories (16 October 2026). Tapas wants the Money dashboard to
-- read like his own sheet and like ET Money / Dezerv: every holding in an
-- asset class (equity, debt, hybrid, gold) with its share of equity, and
-- mutual funds split by their SEBI category.
--
-- New kinds: the instruments that sat under "other". The asset class is
-- DERIVED from the kind (and, for a fund, its category) in
-- lib/money/portfolio.ts, so nothing is stored twice. No new kind is used in
-- this migration, which is why adding them here is safe in one transaction.
alter type public.finance_item_kind add value if not exists 'ppf';
alter type public.finance_item_kind add value if not exists 'epf';
alter type public.finance_item_kind add value if not exists 'nps';
alter type public.finance_item_kind add value if not exists 'ssy';
alter type public.finance_item_kind add value if not exists 'gold';
alter type public.finance_item_kind add value if not exists 'savings';

-- fund_category: a mutual fund's SEBI category key ('large_cap', 'liquid'...),
--   validated in code against FUND_CATEGORIES.
-- equity_pct: an override of the equity share where the default is wrong
--   (NPS on active choice, a hybrid fund). Null means the default.
-- invested: what was put in, where a statement says so, for the gain figure.
alter table public.finance_items
  add column fund_category text
    check (fund_category is null or char_length(fund_category) between 1 and 40),
  add column equity_pct numeric(5, 2)
    check (equity_pct is null or (equity_pct >= 0 and equity_pct <= 100)),
  add column invested numeric(14, 2)
    check (invested is null or invested >= 0);

comment on column public.finance_items.fund_category is
  'SEBI category key of a mutual fund, e.g. large_cap or liquid. NEVER a folio number.';
comment on column public.finance_items.equity_pct is
  'Share of this holding in equity, 0 to 100, when the default for its kind or category is wrong. Null means the default.';
comment on column public.finance_items.invested is
  'Amount invested, in rupees, where known. Null when the statement does not say.';
