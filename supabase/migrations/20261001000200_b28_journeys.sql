-- B28 (part 2 of 2): journeys, and the home city out of trips.cities.
--
-- A journey is one continuous trip serving several engagements. Each
-- engagement stays its own trips row (a "session" on screen); sessions of one
-- journey share a journey_id. There is deliberately NO journeys table: a
-- journey's title and dates are derived from its sessions. Nullable, so a trip
-- with no journey behaves exactly as before.

alter table trips add column if not exists journey_id uuid;

comment on column trips.journey_id is
  'Sessions (trips rows) of one continuous journey share this id. No table: title and dates are derived from the sessions.';

create index if not exists trips_journey_id_idx on trips (journey_id) where journey_id is not null;

-- One-off: remove the home city from trips.cities ("Ahmedabad, Rajkot" becomes
-- "Rajkot"). The same rule the app now applies on write: a case-insensitive
-- prefix match on "ahmedabad" or "sabarmati", so "Ahmedabad (Ambli Road)" goes
-- too. Order of the remaining cities is kept. Legs are not touched.
update trips t
set cities = coalesce(
  (
    select jsonb_agg(c.city order by c.ord)
    from jsonb_array_elements_text(t.cities) with ordinality as c(city, ord)
    where lower(btrim(c.city)) !~ '^(ahmedabad|sabarmati)'
  ),
  '[]'::jsonb
)
where jsonb_typeof(t.cities) = 'array'
  and exists (
    select 1
    from jsonb_array_elements_text(t.cities) as c(city)
    where lower(btrim(c.city)) ~ '^(ahmedabad|sabarmati)'
  );
