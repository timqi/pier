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

/** One round trip: the switch and all four sections. */
export interface BusOverview {
  enabled: boolean;
  topics: BusTopicRow[];
  subs: BusSubRow[];
  notes: BusNoteRow[];
  events: BusEventRow[];
}
