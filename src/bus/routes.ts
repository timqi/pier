// The Console Bus view's HTTP surface: one GET answering the four questions it
// asks — what shared state exists, who listens, what delivery is owed, what
// just happened — plus the one write it makes, seeding the librarian. The area
// owns its routes (the tasks/routes.ts pattern); the capability switch stays
// where every instance setting is, PUT /api/settings busEnabled.

import type { Hono } from "hono";
import type { BusEvent, BusStore } from "./store.js";
import type { SubStore } from "./subs.js";
import type { BusEventRow, BusFactRow, BusLibrarianRow, BusOverview } from "./types.js";

/** How much of a payload a row carries. A page of 50 events at the 8KB cap is
 * a download, not a page — and the whole value is one `bus get` away. */
const PREVIEW = 200;
// One page per section. None of these tables has a natural ceiling — topics
// grow until someone archives, subscriptions live until unsubscribed or
// retired, abandoned notes are never deleted — so the page is capped and says so
// next to the real total, rather than growing until it stops loading.
/** Newest-first, so this is the tail that matters. */
const TAIL = 50;
const TOPICS = 200;
/** Per topic row. A topic with more keys than this is a table, not a fact. */
const FACTS = 20;
const SUBS = 200;
const NOTES = 100;
/** A search term longer than this is a paste, not a search. */
const MAX_QUERY = 64;

const preview = (payload: string): string =>
  payload.length > PREVIEW ? `${payload.slice(0, PREVIEW)}…` : payload;

const factRow = (event: BusEvent): BusFactRow => ({
  key: event.key ?? "",
  payload: preview(event.payload),
  writerSession: event.writerSession,
  createdAt: event.createdAt,
});

const eventRow = (event: BusEvent): BusEventRow => ({
  id: event.id,
  topic: event.topic,
  scope: event.scope,
  kind: event.kind,
  key: event.key ?? null,
  payload: preview(event.payload),
  filePtr: event.filePtr ?? null,
  writerSession: event.writerSession,
  causedBy: event.causedBy ?? null,
  hops: event.hops,
  createdAt: event.createdAt,
});

/**
 * Seeding and finding the librarian, as an injected collaborator rather than an
 * import: listing and creating *tasks* is the task area's business and the bus
 * must not depend on it (docs/architecture.md's one sideways edge stays
 * delivery), while the librarian's marker, schedule and prompt are the bus's own
 * (librarian.ts). main.ts joins the two halves; this file only decides what the
 * answer is.
 */
export interface LibrarianSeam {
  /** Read from the task store on every call. The task *is* the state, so the
   *  view's button has no second boolean to draw from and nothing to drift out
   *  of step with the Tasks panel. */
  list(): BusLibrarianRow[];
  /** Creates an ordinary cron task for `cwd`; the Tasks panel owns it from the
   *  moment it exists. Throws the task layer's own refusal (a cwd that is not a
   *  directory, an unusable timezone) rather than translating it. */
  seed(cwd: string): Promise<BusLibrarianRow>;
}

export function registerBusRoutes(
  app: Hono,
  deps: { events: BusStore; subs: SubStore; enabled: () => boolean; librarian: LibrarianSeam },
): void {
  app.get("/api/bus", (c) => {
    const { events, subs } = deps;
    // The search runs in SQL over whole tables, so the page is a window on the
    // database and not on the 200 rows that happened to load first — without
    // it the 201st topic is unreachable from this surface entirely.
    const q = (c.req.query("q") ?? "").trim().slice(0, MAX_QUERY);
    const topics = events.adminTopics(TOPICS, q);
    const subscriptions = subs.adminSubs(SUBS, q);
    const owed = subs.adminNotes(NOTES, q);
    const tail = events.adminTail(TAIL, q);
    const overview: BusOverview = {
      // The switch rides with the data instead of costing a second request,
      // and the rows come along even when it is off: delivery freezes rather
      // than emptying, so "off" must not read as "nothing is owed".
      enabled: deps.enabled(),
      // Detected, never stored: whether the Bus view offers to seed a librarian
      // or names the one that exists is a question about the task store.
      librarians: deps.librarian.list(),
      // One facts query per topic row, which is why the topic page is capped:
      // the N in N+1 is bounded before it is paid, not after.
      topics: topics.rows.map((row) => {
        const facts = events.adminFacts(row.topic, row.scope);
        return {
          ...row,
          facts: facts.slice(0, FACTS).map(factRow),
          factsMore: facts.length > FACTS,
        };
      }),
      topicsTotal: topics.total,
      subs: subscriptions.rows.map((sub) => ({
        sessionId: sub.sessionId,
        topicGlob: sub.topicGlob,
        mode: sub.mode,
        // The number, not the cursor: "behind by 12" is the fact, and it is
        // counted against the pinned scopes the subscription actually reads.
        lag: events.countSince(sub.topicGlob, sub.scopes, sub.cursor),
        scopes: sub.scopes,
        createdAt: sub.createdAt,
      })),
      subsTotal: subscriptions.total,
      notes: owed.notes.map((note) => ({
        sessionId: note.sessionId,
        topicGlob: note.topicGlob,
        mode: note.mode,
        state: note.callbackState ?? "pending",
        attempts: note.callbackAttempts,
        error: note.callbackError,
        nextAttemptAt: note.callbackNextAttemptAt,
        createdAt: note.createdAt,
        lastEventId: note.lastEventId,
      })),
      notesTotal: owed.total,
      events: tail.events.map(eventRow),
      eventsTotal: tail.total,
    };
    return c.json(overview);
  });

  // The Bus view's one write besides the capability switch, and it creates
  // nothing bus-shaped: everything after this click happens in the Tasks panel.
  app.post("/api/bus/librarian", async (c) => {
    // Off, every run would open a session with no bus tool and report exactly
    // that (the prompt says so) — a daily scheduled no-op.
    if (!deps.enabled()) return c.json({ error: "the bus is off — turn it on before seeding a librarian" }, 409);
    const body = (await c.req.json().catch(() => null)) as { cwd?: unknown } | null;
    const cwd = typeof body?.cwd === "string" ? body.cwd.trim() : "";
    // A relative path would make a librarian whose scope depends on where Pier
    // was started from; the task layer checks that it is a directory.
    if (!cwd.startsWith("/")) return c.json({ error: "an absolute cwd is required" }, 400);
    const existing = deps.librarian.list().find((row) => row.cwd === cwd);
    // Refused with the row, not silently ignored and not created twice: two
    // librarians in one cwd would summarize and archive the same topics against
    // each other every night, and the caller needs to know which one won.
    if (existing) return c.json({ error: `a librarian already maintains ${cwd}`, librarian: existing }, 409);
    try {
      return c.json({ librarian: await deps.librarian.seed(cwd) }, 201);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });
}
