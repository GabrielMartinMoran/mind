<!-- Owner: Mind maintainers | Updated: 2026-10-24 -->

# Web UI

This page is the current map of Mind's browser app: what it does, how it is
organized, and where to look in the source. It is not a user manual. The API and
search behavior it depends on live in [Search engine](search-engine.md); the
memory concepts it shows live in
[Cognitive memory lifecycle](cognitive-memory-lifecycle.md).

## Purpose and audience

The web app is a read-and-edit surface over the same SQLite store as the CLI,
MCP, and REST API. It targets three jobs:

- Browse spaces and memories as an atlas.
- Search with the same pipeline and ranking as `memory_query(search)`.
- Inspect, edit, pin, move, tag, and delete memories without leaving the page.

Maintainers and contributors should start here, then open the source file named
for each area. The normative behavior is in the code and the web tests under
`web/test/`.

## Stack and architecture

There is no build step. The browser loads native ES modules from `web/src/` and
CSS through `@import` in `web/styles/main.css`. Files use `@ts-check` with
JSDoc; `web/jsconfig.json` type-checks `web/src` and `web/test`.

Command icons come from one self-hosted sprite, `web/assets/icons.svg`, a
curated Lucide 0.547.0 subset rendered through `createIcon` in
`web/src/views/icon.js`. There is no CDN or runtime icon package. The helper
builds decorative, `aria-hidden` SVGs on the Lucide 24 px grid with a 2 px
`currentColor` stroke, validates names against a frozen allowlist, and creates
DOM nodes instead of interpolating strings. `web/assets/vendor/LICENSE.lucide`
retains the upstream ISC notice and the MIT notice for the Feather-derived
portions of the selected artwork.

Dependencies point inward, and each layer has one job:

| Layer    | Path                | Responsibility                                                                            |
| -------- | ------------------- | ----------------------------------------------------------------------------------------- |
| API      | `web/src/api/`      | Typed `fetch` wrappers and one error boundary. Knows no views or state.                   |
| Domain   | `web/src/domain/`   | Pure models: search, memory, graph, logs, presenters, sanitizer. No DOM.                  |
| Views    | `web/src/views/`    | Render DOM from data and emit handler callbacks. Depend on domain/API, never the reverse. |
| App      | `web/src/app/`      | Observable store, search controller, route helpers, page composition, polling.            |
| Features | `web/src/features/` | Routing parser/serializer and graph math/interaction helpers.                             |

Entry and bootstrap:

- `web/public/index.html` is the static shell and contains every mount point
  and dialog.
- `web/src/app.js` is the composition root: it wires the store, controllers,
  views, routing, and delegated handlers. It still carries `@ts-nocheck` (see
  [Known limitations and debt](#known-limitations-and-debt)).
- `web/src/app/store.js` holds minimal observable state; `web/src/app/search-controller.js`
  owns request lifecycle, URL sync, and stale-response rejection.
- Mount points include `#list-view`, `#graph-view`, `#space-search-view`,
  `#logs-view`, `#memory-panel`, and the modal dialogs.

## URL contract

The URL is the source of truth for navigation and filters. `parseAppRoute` and
`buildAppUrl` in `web/src/features/routing/routing.js` are the only serializer
and parser.

| Route                                                                                  | Meaning                                               |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `/`                                                                                    | All spaces view with local space search.              |
| `/spaces/{space}?view=list\|map&memory=&q=&tag=&tier=&tiers=1,3&confidence=&semantic=` | Space detail; `memory` opens the panel, `q` searches. |
| `/logs`                                                                                | Logs page.                                            |

Rules:

- Unknown or invalid params are dropped; an invalid `view` canonicalizes to
  `list`; a canonical space URL omits `view=list`.
- Search lives inside the open space; there is no global `/search` route. A
  visit to `/search` canonicalizes to `/` (or the currently open space).
- A query or `confidence` filter opens search inside a space; `tier`, `tiers`,
  and `tag` alone are list filters. This precedence lives in
  `web/src/app/search-route.js`.
- Tiers are inclusive and multi-select. One selected tier serializes as
  `tier=N` for deep-link compatibility; two selected tiers serialize as
  `tiers=N,M`; all three selected tiers are omitted because they mean "no tier
  filter".
- Reload and browser back/forward restore state through `parseAppRoute` and
  `popstate`. Closing the memory panel removes `memory` with `replaceState`.
- `/` and result/card links are real anchors, so middle-click and modifier-click
  keep working.

## Search

The web uses the same pipeline as CLI and MCP. It does not re-rank. For the
pipeline itself, see [Search engine](search-engine.md).

- `GET /api/search` accepts `q`, `space`, `tag`, `tier`, `tiers`, `confidence`,
  `semantic`, `limit`, and `offset`. `tiers` is a comma-separated inclusive
  list (`tiers=1,3`); the single `tier=N` form stays compatible, and `tiers`
  takes precedence when both are present. Invalid or duplicate entries are
  dropped, and an empty result means "no tier filter".
- `GET /api/memories/query` accepts the same `tier`/`tiers` pair along with
  `space`, `tag`, `from`/`to`, `limit`, and `offset`.
- `GET /api/spaces/:space/tags` returns the space's distinct normalized memory
  tags in alphabetical order (empty for an unknown space). The shared filter
  select uses it, so options cover every tier and exclude space tags.
- Results carry `score`, `confidence` (`high`, `medium`, `low`), and `methods`
  provenance. The UI shows them but never recomputes ranking.
- Pagination uses the additive `X-Total-Count` and `X-Has-More` headers, read in
  `web/src/api/search.js`.
- `semantic` is **off by default** in the web UI. The app sends an explicit
  `semantic=off` unless the user enables "Use embeddings". When the server
  reports RAG disabled, the toggle is disabled with an explanation. MCP keeps
  the server default.
- The controller debounces typing (200 ms), aborts in-flight requests, and
  discards stale responses, so a slow query cannot overwrite a newer one.
- Clearing an in-space query removes its stale results and returns to the
  memory list. A matching loaded list is reused; the app fetches only when its
  list filters changed or no matching list is loaded.
- Results are real anchor cards with a stretched link. Descriptive result tags
  are passive data chips (plain spans) outside the single anchor, not buttons or
  links, so filtering stays in the shared tag select. The open affordance is a
  decorative local icon, and the card keeps one accessible name.
- Long result lists scroll inside the search results body while the space header,
  shared filter bar, and result count stay visible; the page itself never
  scrolls. The body keeps at least 120 px of height at 320x700, and every result
  stays reachable in the internal scroller.
- All spaces search is separate from this pipeline. It is client-only (see
  "Spaces, status, and navigation") and never calls `/api/search`.

## Spaces, status, and navigation

- The topbar shows **Logs** as a visible secondary action and **New space** as a
  quieter action. At 600 px and below both compact to named icon buttons: the
  visible label is visually hidden, not removed, and `aria-label` supplies the
  accessible name.
- **New memory** sits beside the space title in the identity row, not in the
  List/Neural Map view switch, and stays available in both views. Below 600 px it
  becomes a named icon action, and the new-memory dialog still returns focus to
  it on close.
- The space header's **Delete space** action pairs the local `trash-2` icon with
  its visible label and stays an outlined destructive trigger; the confirmation
  dialog is the only solid destructive control.
- The sidebar's "Spaces" heading carries a count badge with the total number of
  spaces (not only the visible ones), so hidden-space filtering does not change
  the reported total.
- **All spaces** is the first entry in the sidebar, above the space list and
  separated by a subtle divider. It is a real anchor to `/`, not a synthetic
  space, and it carries `aria-current="page"` only while the home route is
  active. The topbar has no "Atlas / All spaces" breadcrumb.
- All spaces has a compact **Search spaces** field. It filters the loaded
  visible spaces by name, description and tags; matching ignores case and
  accents, and every whitespace token must match somewhere across those fields.
  The search never calls the memory API or changes the URL, keeps its query when
  you open a space and return, and its in-field X clears only the query and
  restores focus. A single polite count ("Showing N of M spaces") and a concise
  no-results note replace the old home summary. All spaces shows no
  space/memory/embeddings summary; the sidebar Storage row always uses the
  global status, even after visiting a space.
- Home status shows the global space and memory totals. The three tier pills
  (T1/T2/T3) stay on one non-wrapping row in the 240 px rail, distributed with
  `justify-content: space-between` across the full rail width, so T3 never
  orphans onto a second line.
- Each All spaces card carries tier signal. The header shows the name and a
  Hidden badge; the description clamps to two lines; a 6 px spectrum bar splits
  into T1/T2/T3 segments proportional to the counts, followed by tier-colored
  counts with tabular numerals. Spaces with no memories show "No memories yet"
  instead of a colored bar and three zeros. The footer keeps the total on the
  left and up to three tags plus `+N` on the right, with long tags truncated.
  Card rows share an equal height, and at 320 px the grid falls back to one
  column with the spectrum and counts still visible. At 1360 px and wider the
  grid uses four equal columns across the available width; below that it keeps
  an adaptive auto-fit layout. The spectrum and counts
  come from the additive `tier_counts {t1,t2,t3}` field returned by
  `GET /api/spaces` (also present on MCP `space_list`); the three counts sum to
  `memory_count`.

## Filter bar

The open space has one filter bar for the list, the map, and in-space search.

- At desktop widths the bar is one centered row: search, tag, T1/T2/T3 chips,
  confidence, embeddings, only-matches, and **Clear filters**. The search field
  keeps a 280 px basis below 1360 px so the remaining controls still fit on one
  row at 1280 px, and 340 px at 1360 px and wider, where the primary filter gap
  grows from 8 px to 12 px. At 1280 px the flexible field stays at or below
  320 px.
- The tag control is a native select. Its first option, **All tags**, is the
  empty value; the rest are the active space's memory tags from
  `GET /api/spaces/:space/tags`, alphabetically sorted and drawn from every
  tier. Space tags are not options. A URL tag that is missing from the latest
  list stays selected as a temporary option instead of being dropped.
- Visible field labels move into placeholders and visually hidden labels. The
  embeddings help text stays in the accessibility tree through
  `aria-describedby` and a label tooltip instead of adding a second visual line.
- Hidden contextual controls (confidence, embeddings, only-matches) take no
  space and do not change the row height.
- Below 700 px the search takes a full row and the other fields wrap into
  additional rows without horizontal overflow. At 480 px and below the tag
  select shares a row with the tier chips, and the confidence select shares a
  row with the embeddings toggle, so the fixed header leaves at least 120 px for
  the scrolling results body at 320x700.

## Memory list

- Each memory card is one compact row (about 42–44 px) at 860 px and wider: a
  quiet tier marker (7 px colored dot plus `T2`) leads, the truncated name
  follows, and a right-aligned metadata group carries the tags beside the
  tabular changed date. The tag group uses the available horizontal room by
  growing left from the date toward the name, so tags are fully visible while
  space remains; it never overlaps the name, and the changed date stays at the
  far right. Tags truncate only when the row is genuinely width-constrained,
  while the name keeps its own region. Pinned memories show a passive text
  indicator; the card has no pin control. Below 860 px the tier and name share a
  row, the metadata stacks or wraps beneath it, and the page has no horizontal
  scroll.
- The whole card remains a single stretched link. Pinning and unpinning live in
  the memory panel (`#btn-mem-pin`), not on the card. List commands such as
  **Show more**, **Add a memory**, and **Retry** keep their visible label beside
  a decorative local icon.

## Memory panel

The panel is one native `<dialog>` that renders a memory's metadata, tags, and
content without leaving the current view. Markdown content goes through
`marked` and the allowlist sanitizer in `web/src/domain/sanitize.js`; sanitized
nodes are appended from an inert `<template>`, never assigned with `innerHTML`.

Valid JSON objects and arrays take a separate path. When trimmed content starts
with `{` or `[` and `JSON.parse` succeeds, the panel renders two-space pretty
JSON in a `<pre class="json-viewer">`. Keys and each value type get classes
(`json-key`, `json-string`, `json-number`, `json-boolean`, `json-null`, plus
neutral `json-punct`), so the text is colored while punctuation stays quiet. The
highlighter in `web/src/domain/json-viewer.js` returns plain text tokens; the
view appends them with `textContent` and text nodes, so JSON strings containing
HTML stay inert. The pretty document remains real selectable/copyable text. Long
keys and string values wrap at the panel width (`pre-wrap` plus
`overflow-wrap: anywhere`), so the block never scrolls horizontally and the
two-space indentation is preserved.

Anything else — invalid JSON, primitives, or ordinary markdown/text — falls back
to the existing renderer. Panel metadata, edit mode, actions, and tag PATCH
behavior are unchanged. Removable space and memory tags render as named buttons
whose remove icon is decorative; the add-tag control carries a tag icon.

## Logs

- Logs is a visible secondary topbar action, distinct from the quieter **New
  space** control.
- The Logs page header puts "Clear logs" inline at the right of the title row,
  not in a separate action strip below it. Clear, retry, and pagination commands
  pair a decorative icon with a visible label, while page numbers and the
  source/level/tier marks stay icon-free.
- The table is bounded to the page: its wrapper scrolls internally
  (`scrollHeight > clientHeight`) with a sticky header, so long log pages do not
  clip against `#main-content` or force the whole page to grow.
- An **Agent** column sits between Source and Operation. It reads
  `caller_info` and shows the compact label for a known agent (OpenCode, Claude
  Code, Codex, Cursor, Windsurf, Gemini CLI, VS Code, Antigravity, Pi), the raw
  canonical name for an unknown value, and `—` with an accessible "No agent
  recorded" label for CLI/API rows. The raw canonical name stays in the cell
  `title`, and the full `caller_info` JSON remains in the existing Details row;
  arbitrary caller data is never rendered in the table. Agent identity comes from
  the `MIND_AGENT` environment variable written by `mind setup`, with the MCP
  initialize `clientInfo` as the fallback. The table wrapper scrolls
  horizontally, so the actions column stays reachable at 320 px and the table
  uses the available width at 1280 px without page overflow. At narrow widths
  (≤ 599 px) the stacked filter chrome no longer clips the table: the logs page
  scrolls vertically, the wrapper keeps a 180 px minimum height, and the table
  scrolls both directions inside that wrapper, so every row and its Details
  action stay reachable at 320×700.

## Graph

The Neural Map is a client-side view of the graph payload from
`GET /api/spaces/:space/graph?limit=1000`. One request asks for every node the
backend can serve; there is no 300-node page and no separate "load full" step.

- Layout is a deterministic multi-lane radial map: each tier (T1/T2/T3) owns
  concentric lanes, nodes are partitioned by circle weight, and every lane
  radius is sized from its circumference demand plus a fixed gap. Adjacent lanes
  are separated by at least `2 × maxRadius + gap`, so circles on different lanes
  cannot touch. Tier boundaries keep an equal 100-world-unit gap (T1→T2 and
  T2→T3) so the tiers read as evenly spaced groups. The 465- and 567-node spaces
  render every node with zero overlaps and a positive minimum screen gap at 320,
  1280, and 1920 px.
- Node radius encodes combined in/out degree on a square-root scale (8.5–21 px;
  dense maps use a slimmer 7–16 px envelope), so hubs read larger without
  letting one heavily linked memory dominate. The scale is capped: a 411-node
  graph with a maximum degree of 62 still renders without overflow.
- The link count is rendered centered inside each node, and its font size is
  fitted to the node (8–13 px) so labels and counts stay inside the circle with
  no overflow.
- Search highlighting dims non-matches; "Only matches" hides everything else
  and announces the count.
- Tier filters (T1/T2/T3) combine with search filtering.
- Filtering is client-side in v1; the server is not re-queried per filter.
- The SVG is `role="group"` with roving-tabindex nodes. Arrow keys move to the
  nearest node in that direction; Home/End jump to the first/last; Enter opens
  the memory.
- Every rendered node also appears in an accessible "Memory list" table whose
  rows link to the memory. The table is a collapsible `<details>` element: open
  when the graph has 50 or fewer nodes and collapsed for denser graphs. A plain
  primary click on a row opens the memory panel and selects/highlights the
  matching node without leaving the map or refetching the graph; modifier-click
  and middle-click keep the anchor's native behavior.
- Node `aria-label`s include the linked-memory count ("1 link" / "N links"), so
  the degree signal is available to assistive technology as well as visually.
- Dragging to pan the map never selects graph text; the accessible memory table
  stays normally selectable and copyable.
- The graph, list, and space content share a 16 px right/bottom gutter against
  the viewport, so the map and the list align on the same edges.
- Dense maps (>80 rendered nodes) cull visual noise without hiding data: no
  persistent name labels are drawn, at most 200 context edges are kept around
  focused nodes, and every node keeps its in-circle degree number and its
  accessible table row. Exactly one transient name label appears for the
  selected node, otherwise for the keyboard-focused node, otherwise for the
  hovered node. Selecting a node always adds its incoming and outgoing edges,
  even when the 200-edge context cap omitted them, so a low-degree memory in a
  dense map still shows every incident link. Those extra edges are transient DOM
  additions and are removed on deselect without rebuilding or refetching the map.
- Small maps (≤80 rendered nodes) show every name label. Labels are sized in
  screen space from the measured viewBox fit and zoom (11.5 px at the base zoom,
  up to 13 px) with a contrast halo. Names truncate at 25 characters on small
  maps and 24 on dense transient labels; the full name stays available to
  assistive technology and as a tooltip.
- Selecting a memory (click, keyboard activation, or opening it in the panel)
  highlights its incident edges on both sides, emphasizes its neighbors, and
  mutes unrelated edges. The memory panel's modal backdrop is lighter so the map
  stays visible behind the open detail.
- The open-space search input is `type="text"` with a custom clear button that
  is always visible inside the field (not below it). There is no native
  browser-provided clear control, so the single clear affordance is consistent
  across browsers.
- All available nodes are shown. If the backend itself caps the payload (its
  current maximum is 1,000 nodes), a quiet "Showing X of Y nodes" note appears;
  there is no action button because the single request already asked for the
  maximum. Search matches outside the returned set keep their own count note.

## Accessibility

The app targets WCAG 2.2 AA.

- Landmarks, a skip link to `#main-content`, one `h1` per view, and a logical
  heading order.
- Focus is visible (accent outline with offset); dialogs, the mobile drawer, and
  the memory panel return focus to their trigger on close.
- `#memory-panel`, the create/edit dialogs, and the delete confirmation are
  native `<dialog>` elements opened with `showModal()`, with a fallback path.
- Live regions (`aria-live="polite"`) announce result counts, graph matches, and
  loading/error state without stealing focus.
- `prefers-reduced-motion` removes transitions and ambient animation.
- Decorative icons are `aria-hidden` and not focusable. Icon-only actions carry a
  descriptive `aria-label`, and compact mobile controls keep their visible label
  in the DOM for assistive technology.
- Keyboard shortcuts: `/` focuses the open space's search input, arrows and
  Home/End move through results, and Escape clears the input or closes the
  current dialog.
- Navigation controls are at least 24×24 px, and layout reflows without
  horizontal scrolling at 320 px and 200% zoom.

## Design system

Tokens live in `web/styles/tokens.css`; components consume them from
`web/styles/components/*.css`.

- Dark-only identity (`color-scheme: dark`), with no theme switcher.
- Color encodes data: T1 hot, T2 warm, T3 cold, plus success/warning/danger.
  Tier color is always paired with text (`T1`/`T2`/`T3`), never the only signal.
- Type scale is 12/13/14/16/20/26/34 px with a 72ch measure.
- The accent (`--accent`) marks focus, selection, and primary actions.
- Command actions use one line-icon language: a decorative Lucide symbol from the
  local sprite, 16 px in a 24 px grid with a 2 px `currentColor` stroke. Visible
  text labels stay by default; icon-only controls keep a descriptive accessible
  name. Icons mark commands, not state: tier chips, selects, checkboxes, page
  numbers, and source/level/tier badges remain icon-free.
- Action hierarchy is carried by boundaries, not color alone: one accent primary
  per surface, secondary actions carry a visible surface/border (**Logs**), quiet
  actions stay unfilled (**New space**, **New memory**), and destructive
  triggers are outlined while only the final confirmation is solid.
- No glow, no glassmorphism, and no ambient pulse. Motion is limited to state
  changes.

## Testing

Web tests use `bun:test` with `happy-dom` and live in `web/test/`.

- Pure domain models and routing are unit-tested without a DOM.
- Views and app wiring are DOM integration tests: shell, search, list, panel,
  modals, graph, logs, focus, and keyboard behavior.
- Icon tests pin the local sprite's symbol ids, `aria-hidden`/`currentColor`
  contract, license notice, and `createIcon` output.
- App-boot tests mount the real shell and exercise routes end to end in the
  simulated DOM.
- Automated checks: `bun test test/ web/test`, `bun run typecheck`,
  `bun run lint`, `bun run format:check`.
- Playwright was used during development as manual real-browser evidence for
  focus, inert drawers, dialogs, graph interaction, and console errors. It is
  not a committed suite.

## Known limitations and debt

These are accepted for this cycle and should not be presented as complete:

- `web/src/app.js` still carries `@ts-nocheck`. Removing it surfaces about 48
  TypeScript errors (mostly DOM narrowing and payload typing); the typed split is
  a follow-up.
- Legacy duplicate CSS rules for some components remain alongside the tokenized
  component split. They are not fully inert: they are partially overlapping
  debt, and some legacy rules still set the same properties as the tokenized
  ones. The toast container is a concrete example — `web/src/app.js` creates
  `#toast-container` and tokenized styles now target that id in
  `web/styles/components/feedback.css`, which is imported after the legacy
  `web/styles/components.css` rule so the tokenized values win. Duplicate toast
  rules remain in both files and keep the cascade harder to read.
- Graph filtering is client-side v1. A backend-capped payload (currently above
  1,000 nodes) and matches outside the loaded set are handled with a quiet
  notice, not server-side filtering; there is no separate load-more step.
- The theme is intentionally dark-only.
- There is no committed E2E suite; real-browser and screen-reader coverage stays
  manual.

## Related documentation

- [Documentation index](README.md)
- [Search engine](search-engine.md)
- [Cognitive memory lifecycle](cognitive-memory-lifecycle.md)
- [Agent integration matrix](agent-integration-matrix.md)
- [Verification harness](verification-harness.md)
