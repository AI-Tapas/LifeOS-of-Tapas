-- Milestone 6c: how the hotel is arranged.
--
-- One column, four values. It is not a label: it decides which checklist step
-- the app creates, so the same trip screen asks him to confirm a hotel, book
-- one, or nothing at all.
--
--   branch     the ICAI branch arranges it (the norm on almost every trip)
--   self       he books it himself, and it is a reimbursable expense
--   relative   staying with family: no booking, no cost, no step
--   same_day   returning the same day: no accommodation at all
--
-- Nullable, and deliberately NO database default. What a new trip starts on
-- depends on its dates (a day return needs no hotel), which is app knowledge
-- rather than a column constraint, so it lives in lib/trips/checklist.ts
-- (defaultHotelArrangement).
--
-- Backfill: existing rows stay null on purpose. Nothing is guessed here.
-- Readers resolve a null to 'branch', the norm, exactly as a new trip
-- defaults (resolveHotelArrangement). Industry batches at company sites are
-- the exception he sets by hand.
--
-- Confidential boundary unchanged: no hotel name, address, booking reference
-- or document. Only which of four arrangements applies.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'hotel_arrangement') then
    create type hotel_arrangement as enum ('branch', 'self', 'relative', 'same_day');
  end if;
end $$;

alter table trips
  add column if not exists hotel_arrangement hotel_arrangement;
