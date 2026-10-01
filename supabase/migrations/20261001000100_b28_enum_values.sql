-- B28 (part 1 of 2): enum values for non-ICAI (client) training trips.
--
-- Values only, and nothing in this file USES one: Postgres refuses to use an
-- enum value in the transaction that adds it, which is why the column work is
-- in 20261001000200_b28_journeys.sql.
--
--   trip_purpose      training  "Training (non-ICAI)": e.g. Cygnet training its clients
--   trip_bills_to     client    reimbursed by the client, the client being the
--                               session's work stream
--   hotel_arrangement client    the client books travel and hotel

alter type trip_purpose add value if not exists 'training';
alter type trip_bills_to add value if not exists 'client';
alter type hotel_arrangement add value if not exists 'client';
