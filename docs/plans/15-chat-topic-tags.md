# Chat topic tags — every message names the open item it belongs to

Status: building. Branch `chat-topic-tags`, not merged.

## Decisions

- The chat stream stays as it is: one chronological column. A topic is a
  mark on a row, never a regrouping.
- The key is the open item's `problem`. The head names its topic with a
  `<topic>problem</topic>` marker; a reply carrying that item's `<open>`/`<done>`
  needs none (`replyTopic`, `core/reply.ts`). A reply about nothing on the
  list carries neither and is not tagged.
- Attribution is read off the transcript on the client, never stored: the
  assistant row by its own marker; the user row above it and the process line
  under it inherit that topic. No new table, route or seam.
- Colour is a stable hash of the problem (`topicHue`), so a topic looks the
  same in the chat, the status panel and after a reload.
- Done topics come from the `<done>` markers the pane has seen — the last five
  stay filterable in the panel; the server's `open_items` is unchanged.
- Process rows — background-run cards, delegation and callback inputs — fold
  into one line under the reply they follow, opening to the cards. Seeds,
  chat commands and errors are not process rows.
- IM strips `<topic>` like every other marker and shows no tag: no footer
  change, `AgentReply` untouched.

## Changes

1. `core/reply.ts`: `topic` joins the hidden tags and the marker regex;
   `openItemMarkers` returns `topic`; `replyTopic(markdown)`.
2. `agent/roles.ts` DISPATCHER: one line asking for the marker.
3. `web/ui/topics.ts` (new): hue, tagging a row, the filter, the topic
   registry (`seen`/`done`) the panel reads.
4. `web/ui/chat.ts`: tag assistant rows on append, user row above them;
   process rows fold under the last reply; the filter applied to new rows.
5. `web/ui/turn-activity.ts`: `renderBackgroundRun` appends into the process
   fold instead of `#turns` directly.
6. `web/ui/drawer.ts`: colour dot per item, "only this topic" switch per item
   and per recent done topic; the chip stays while done topics exist.
7. `web/ui/style.css`: the colour bar and label, the process fold line.
8. Docs: [10 §Open items](../design/10-continuous-session.md#open-items),
   [03 §Chat pane / Bar and status panel](../design/03-web-workbench.md).

## Worker runs

- core + prompt + docs 10: lead, done.
- web (3–7, docs 03): one worker, branch `chat-topic-tags-web`.
