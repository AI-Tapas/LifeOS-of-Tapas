-- Whose holding this is (16 October 2026). Tapas manages his mother's mutual
-- funds and the FDs in her name, and also wants to keep his wife's and his
-- parents-in-law's investments on record, for reference only.
--
-- held_for: null means his own; otherwise a short relation label such as
-- 'Mother'. The Money screen groups and totals by it.
-- reference_only: true keeps a holding out of every summary surface (the
-- Money dashboard, Home, the morning brief) and off the calendar. It is shown
-- only in its holder's own section on the Money screen.
--
-- Additive, so every existing row stays his and counts as before. RLS unchanged.
alter table public.finance_items
  add column held_for text
    check (held_for is null or char_length(btrim(held_for)) between 1 and 40),
  add column reference_only boolean not null default false;

comment on column public.finance_items.held_for is
  'Whose holding this is, as a short relation label such as Mother. Null means his own. NEVER a PAN, an account number, a folio number or a login.';
comment on column public.finance_items.reference_only is
  'True: kept for reference only. Never on the Money dashboard, Home or the brief, and never reminded on the calendar.';
