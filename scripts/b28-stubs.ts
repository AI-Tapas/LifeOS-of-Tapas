// B28 test helper: the B26 in-memory database and no-op stand-ins, plus the two
// trip calendar functions the real lib/trips/write.ts calls. Because the real
// write.ts is loaded here, the trips write stubs of b26-stubs are never
// imported by anything. Synthetic data only. Loaded through b28-loader.mjs.

export * from "./b26-stubs.ts";

const noop = async () => undefined;
export const syncTripEvent = noop;
export const removeTripEvent = noop;
