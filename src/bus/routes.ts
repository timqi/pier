// The bus over HTTP, read-only: one GET answering the four questions the
// Console's Bus view asks — what shared state exists, who listens, what
// delivery is owed, what just happened. The area owns its routes (the
// tasks/routes.ts pattern); the only bus write a browser may make stays the
// existing PUT /api/settings busEnabled.

import type { Hono } from "hono";
import type { BusEvent, BusStore } from "./store.js";
import type { SubStore } from "./subs.js";
import type { BusEventRow, BusFactRow, BusOverview } from "./types.js";

/** How much of a payload a row carries. A page of 50 events at the 8KB cap is
 * a download, not a page — and the whole value is one `bus get` away. */
const PREVIEW = 200;
/** One page of the stream. Newest-first, so this is the tail that matters. */
const TAIL = 50;

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

export function registerBusRoutes(
  app: Hono,
  deps: { events: BusStore; subs: SubStore; enabled: () => boolean },
): void {
  app.get("/api/bus", (c) => {
    const { events, subs } = deps;
    const overview: BusOverview = {
      // The switch rides with the data instead of costing a second request,
      // and the rows come along even when it is off: delivery freezes rather
      // than emptying, so "off" must not read as "nothing is owed".
      enabled: deps.enabled(),
      // One facts query per topic row. A bus with enough topics for that to
      // matter has a retention problem this page is how you find.
      topics: events.adminTopics().map((row) => ({
        ...row,
        facts: events.adminFacts(row.topic, row.scope).map(factRow),
      })),
      subs: subs.adminSubs().map((sub) => ({
        sessionId: sub.sessionId,
        topicGlob: sub.topicGlob,
        mode: sub.mode,
        // The number, not the cursor: "behind by 12" is the fact, and it is
        // counted against the pinned scopes the subscription actually reads.
        lag: events.countSince(sub.topicGlob, sub.scopes, sub.cursor),
        scopes: sub.scopes,
        createdAt: sub.createdAt,
      })),
      notes: subs.adminNotes().map((note) => ({
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
      events: events.adminTail(TAIL).map(eventRow),
    };
    return c.json(overview);
  });
}
