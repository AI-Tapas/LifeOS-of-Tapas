// B29 safety proofs for the real lib/family/sync.ts: a failed read must stop
// the run before any Google call. Run: npm run test:b29. Offline; the database
// and Google are stand-ins (b29-sync-loader.mjs, b29-sync-stubs.ts).

import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { reset, world } from "./b29-sync-stubs.ts";

register("./b29-sync-loader.mjs", import.meta.url);
const { syncFamilyTravel, clearFamilyTravel } = await import("../lib/family/sync.ts");

const USER = "user-1";

function seed() {
  reset();
  world.tables = {
    calendars: [{ id: "c1", user_id: USER, account_id: "a1", ext_calendar_id: "cal-fam", is_family_travel: true }],
    accounts: [{ id: "a1", status: "connected" }],
    trips: [
      {
        id: "t1", user_id: USER, status: "booked", session_date: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
        cities: ["Surat"], legs: [],
      },
    ],
    work_streams: [{ user_id: USER, name: "Cygnet" }],
    family_travel_events: [
      { id: "r1", user_id: USER, trip_id: "t-old", kind: "session", item_key: "2026-01-01", ext_event_id: "e1", ext_calendar_id: "cal-fam", content_hash: "h" },
    ],
    audit_log: [],
  };
}

test("a failed trips query makes zero Google calls and reports ran:false", async () => {
  seed();
  world.failRead.add("trips");
  const r = await syncFamilyTravel(USER);
  assert.equal(r.ran, false);
  assert.deepEqual(world.google, [], "nothing created or deleted");
  assert.equal(world.tables.family_travel_events.length, 1, "the record is kept");
});

test("a failed read of the recorded events makes zero Google calls", async () => {
  seed();
  world.failRead.add("family_travel_events");
  const r = await syncFamilyTravel(USER);
  assert.equal(r.ran, false);
  assert.deepEqual(world.google, []);
});

test("a failed work streams read, or calendars read, also stops before Google", async () => {
  for (const t of ["work_streams", "calendars"]) {
    seed();
    world.failRead.add(t);
    const r = await syncFamilyTravel(USER);
    assert.equal(r.ran, false, t);
    assert.deepEqual(world.google, [], t);
  }
});

test("a failed read in a clear also stops before Google", async () => {
  seed();
  world.failRead.add("family_travel_events");
  const r = await clearFamilyTravel(USER);
  assert.equal(r.ran, false);
  assert.deepEqual(world.google, []);
});

test("with every read good, the sync runs: the stale record is deleted and the trip's session is created", async () => {
  seed();
  const r = await syncFamilyTravel(USER);
  assert.equal(r.ran, true);
  assert.deepEqual(world.google.sort(), ["create", "delete"]);
  assert.deepEqual(world.tables.family_travel_events.map((x) => x.trip_id), ["t1"]);
  assert.equal(world.tables.family_travel_events[0].ext_calendar_id, "cal-fam");
});

test("a clear deletes every recorded event from its recorded calendar and ignores the flag", async () => {
  seed();
  world.tables.calendars[0].is_family_travel = false; // flag already moved
  const r = await clearFamilyTravel(USER);
  assert.equal(r.ran, true);
  assert.deepEqual(world.google, ["delete"]);
  assert.equal(world.tables.family_travel_events.length, 0);
});
