// The day after a full day on stage (backlog B5, persona inferred item 5).
//
// An AICA session is a whole day of teaching, and it usually sits on the far
// end of an overnight journey. The day after it is the day he is least able to
// absorb a full desk, and it is exactly the day that quietly fills up.
//
// This is an OBSERVATION, deliberately. It declines nothing, moves nothing and
// writes no calendar entry to hold time: the same shape as the weekend guard,
// which names a risk and then gets out of the way. He decides what to do with
// the day; the app only refuses to let it happen unnoticed.
//
// Pure so Home and the assistant's context read the same answer, exactly as
// reviewLine and weekendGuard already do. Relative .ts imports so node --test
// resolves them without a bundler.
import { addDays, civilKey, type CivilDate } from "../datetime.ts";

export interface RecoveryTrip {
  id: string;
  title: string;
  status: string;
  session_label: string | null;
  session_date: string | null; // YYYY-MM-DD, the day he is actually teaching
  end_date: string | null; // YYYY-MM-DD, when the travel ends
  cities: string[];
}

// Which day the trip actually stood him up in front of a room. session_date
// where the trip carries one (M7d: it is often neither the start nor the end
// of the travel), and the last day of the trip where it does not. A trip with
// no dates at all cannot say anything and returns null rather than guessing.
export function sessionDayKey(t: RecoveryTrip): string | null {
  return t.session_date ?? t.end_date ?? null;
}

// A short human label for the session: "L1D2, Bangalore" where the trip
// carries a session label, and the trip's own title where it does not.
export function sessionLabel(t: RecoveryTrip): string {
  const city = t.cities[0] ?? null;
  if (t.session_label) {
    return city ? `${t.session_label}, ${city}` : t.session_label;
  }
  return t.title;
}

// Trips whose session day was YESTERDAY, which makes today the recovery day.
// Cancelled trips never count: he did not stand up anywhere.
export function recoveryTrips(trips: RecoveryTrip[], today: CivilDate): RecoveryTrip[] {
  const yesterday = civilKey(addDays(today, -1));
  return trips.filter(
    (t) => t.status !== "cancelled" && sessionDayKey(t) === yesterday
  );
}

// One plain line, in the weekend guard's voice. Null when there is nothing to
// say, so neither Home nor the model's context renders an empty observation.
export function recoveryLine(trips: RecoveryTrip[]): string | null {
  if (!trips.length) return null;
  if (trips.length === 1) {
    return `Yesterday was a full day on stage: ${sessionLabel(trips[0])}.`;
  }
  return `Yesterday carried ${trips.length} sessions: ${trips
    .map(sessionLabel)
    .join(", ")}.`;
}

// The advice that follows the observation, kept beside it so Home and the
// brief-style surfaces cannot word it differently.
export const RECOVERY_ADVICE =
  "Today is a recovery day. Take on what has to happen and let the rest wait.";
