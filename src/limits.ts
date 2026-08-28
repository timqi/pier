// The numbers more than one area has to agree on.
//
// Not policy or behaviour — a value several modules must spell the same way,
// and a wrong copy makes two surfaces disagree about one session: a title
// truncated to a different length depending on which path derived it.
//
// Here because a leaf may be imported by every area and depends on nothing
// itself, which is the only shape that fits: agent/ derives a title and must
// not import core/, web/ derives one too and must not import agent/, and the
// browser needs the same numbers with no runtime behind them.

/** How much of a message becomes a title, wherever one is derived: the listing
 *  reading a transcript (agent/listing.ts), a rename's fallback (agent/pi.ts),
 *  the fill at first prompt and the rename boundary (web/). */
export const SESSION_TITLE_MAX = 80;
