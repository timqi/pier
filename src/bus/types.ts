// The wire shapes `GET /api/bus` answers with — one copy, filled by
// bus/routes.ts and drawn by the Console's Bus view, which imports this file
// type-only (docs/architecture.md's DTO convention). Declarations only, and it
// imports nothing: a browser program that reached the store through this file
// would be compiling Node's sqlite bindings.

export type BusKind = "event" | "fact" | "tombstone";

/** What one (topic, scope) looks like from outside every scope fence — the
 *  shape BusStore's admin query returns and this file extends with the facts. */
export interface BusTopicCounts {
  topic: string;
  scope: string;
  events: number;
  archived: number;
  newestAt: string;
  /** Epoch ms of the last get/log that reached the topic; null = never read. */
  lastReadAt: number | null;
}

/** One live fact under a topic: the shared state, as a preview. */
export interface BusFactRow {
  key: string;
  /** Truncated JSON — a preview of the value, not the value. */
  payload: string;
  writerSession: string;
  createdAt: string;
}

/** A (topic, scope) with its live facts inline: one row answers both "how much
 *  history is here" and "what does it currently say". */
export interface BusTopicRow extends BusTopicCounts {
  facts: BusFactRow[];
  /** More live facts than this row carries; the rest are one `bus get` away. */
  factsMore: boolean;
}

export interface BusSubRow {
  sessionId: string;
  topicGlob: string;
  mode: string;
  /** Events the cursor is behind, counted against the sub's *pinned* scopes —
   *  the number a notification would carry, not the cursor string. */
  lag: number;
  scopes: string[];
  createdAt: string;
}

/** A pointer notification still owed, or given up on. */
export interface BusNoteRow {
  sessionId: string;
  topicGlob: string;
  mode: string;
  state: string;
  attempts: number;
  error: string | null;
  nextAttemptAt: number | null;
  createdAt: number;
  lastEventId: string;
}

/** A seeded librarian, as the Bus view needs to see it: an ordinary scheduled
 *  task the Tasks panel owns, keyed by the cwd it maintains. Its presence *is*
 *  the view's display state — there is no stored flag saying a librarian was
 *  seeded, because the task is the only thing that could make it true. */
export interface BusLibrarianRow {
  taskId: string;
  name: string;
  /** The working directory its runs get, and therefore the scopes it sees. */
  cwd: string;
  /** Human-readable trigger, e.g. `0 5 * * * (Asia/Shanghai)`. */
  schedule: string;
  /** Paused in the Tasks panel: it exists and will not run. */
  enabled: boolean;
}

export interface BusEventRow {
  id: string;
  topic: string;
  scope: string;
  kind: BusKind;
  key: string | null;
  /** Truncated JSON, rendered as text — never as markup. */
  payload: string;
  filePtr: string | null;
  writerSession: string;
  causedBy: string | null;
  hops: number;
  createdAt: string;
}

/** One round trip: the switch and all four sections. Every section is a capped
 *  page beside the true total — the count is what the tab label shows and what
 *  makes "200 of 431" sayable, and a surface that quietly shows a prefix is a
 *  surface that lies about how much is there. Under `?q=` every total is the
 *  *matched* total, counted in SQL across the whole table. */
export interface BusOverview {
  enabled: boolean;
  /** Every librarian task that exists right now. Not searched and not capped:
   *  it is one row per maintained project, and the button above the tabs is
   *  drawn from it. */
  librarians: BusLibrarianRow[];
  topics: BusTopicRow[];
  topicsTotal: number;
  subs: BusSubRow[];
  subsTotal: number;
  notes: BusNoteRow[];
  notesTotal: number;
  events: BusEventRow[];
  eventsTotal: number;
}
