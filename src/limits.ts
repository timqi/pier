// The numbers more than one area has to agree on.
//
// Neither is policy or behaviour — each is a value several modules must spell
// the same way, and a wrong copy makes two surfaces disagree about one
// session: a title truncated to a different length depending on which path
// derived it, a rail promising seven days while the server counts eight.
//
// Here because a leaf may be imported by every area and depends on nothing
// itself, which is the only shape that fits: agent/ derives a title and must
// not import core/, web/ counts the lease and must not import agent/, and the
// browser needs the same numbers with no runtime behind them.

/** How much of a message becomes a title, wherever one is derived: the listing
 *  reading a transcript (agent/listing.ts), a rename's fallback (agent/pi.ts),
 *  the fill at first prompt and the rename boundary (web/). */
export const SESSION_TITLE_MAX = 80;

/** How long a session stays in Projects on its own after its last turn. Long
 *  enough to cover a weekend away from a piece of work, short enough that a
 *  week of throwaway sessions is not still on screen a month later.
 *  web/session-state.ts enforces it; the rail says it out loud. */
export const PROJECT_LEASE_MS = 7 * 24 * 60 * 60 * 1000;
