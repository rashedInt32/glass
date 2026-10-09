# glass: render spec

The contract for how glass draws Claude Code's transcript on the terminal.
Code follows this file; undocumented deviations are bugs. Settled by a
design panel and an investigation round on 2026-10-02. The file grows by
pass: a later section replaces an earlier one where they differ, and a
bullet or section marked (Superseded) is history, not a rule.

## Global

- Measure `M = columns - 2`, full width, recomputed per draw: the reply
  runs as wide as the engine's own tool output, so nothing reads as a hole
  on the right. (A 100-column cap was tried and rejected on a 190-column
  terminal.) Prose, lists and cards never exceed M.
- One width ruler: `cellWidth()` in `hooks/width.ts`, mirroring the engine's
  `Bun.stringWidth(s, { ambiguousIsNarrow: true })`. Never code-point length.
- Glyph encoding: every non-ASCII glyph comes from `hooks/glyphs.ts`, built
  with `String.fromCodePoint`. No literal or `\u` escape outside ASCII in
  `hooks/`, comments included. Check: `LC_ALL=C grep -rn '[^ -~]' hooks/`
  prints nothing (BSD grep on macOS has no `-P`).
- Rhythm: `marginTop: 1` on every block except the first of a text block and
  any block right under a heading. Never `marginBottom`, never spacer boxes.
  The first block of a reply keeps `marginTop: 1`. No reply bullet: the
  assistant header carries it.
- Tint only on the two cards, code fences and the Bottom line (`blockBg`,
  >= 1.2:1 over the terminal bg). Cards hug their content: width = widest
  row plus padding, floor 60 cells, cap M. Inline code has no tint.
- No `dimColor` in a reply: the fence header draws in `faint` (0.4.20),
  so every dim step is a palette key.
- Never `wrap: 'truncate*'` in the reply body. A width mistake must wrap,
  never lose text.
- A tree that would be refused reverts the whole message to the engine's
  renderer. So: reply text is normalized on entry (CRLF to LF, C0 controls
  other than tab and newline removed), Text and Code strings stay under
  10000 characters (a longer run goes as several strings side by side in
  the same Text, so it draws the same), `Link` only gets `https:` or `http://localhost` hrefs, props
  are set conditionally rather than passed as `undefined`.

## Inline

- Plain text default color, with claude-hl's prose passes ported:
  - Command spans in prose paint only with evidence: a known command word
    followed by a flag, path, string, number or operator, or preceded by a
    runner prefix (`Ran`, `$`). `git push --follow-tags` paints; `git
    status` in a sentence, `make sure`, `go ahead` do not. For command
    words that are also plain English (`sleep`, `code`, `time`, `open`,
    `find`...) a bare number is not evidence: `each sleep 5 seconds` and
    `code across 13 files` stay prose; `Ran sleep 5` and `code -r` paint.
    Stop words and a three-bare-word budget end a span. (`proseSpans` in
    `hooks/shell.ts`.)
  - Paths anywhere: rooted (`/`, `./`, `../`, `~/`), a known extension
    (`README.md`) or a dotfile (`.gitignore`) in `path` underlined; a
    `:line` or `:line:col` suffix in `num`. URLs (`https`, `ssh://`,
    `git@`, `www.`) in `url` underlined. (`hooks/paths.ts`.)
- A paragraph opening with `Private` or `Privately` is Claude's own
  planning note: drawn whole, italic, in `private`.
- A paragraph that needs the reader gets a gutter mark: `▎` in `mark` in
  the two cells other blocks leave blank. Needs the reader = a question
  mark, an imperative opener, or an attention phrase (asks, things not
  done, risks), the tables in `hooks/prose.ts`. Never on list items,
  headings, code or cards. Off for the
  whole turn when the prompt asked for writing (`write`, `draft`, …
  among its first six words).
- `**bold**` bold in `bold`. `*italic*` italic. `~~strike~~` strikethrough.
- Links: `https` and `http://localhost` become `Link` with the label in
  `url` color underlined; any other href draws as that styled text only.
- Inline code is color only, as Claude Desktop and the Codex TUI draw it.
  No tint, no padding, no caps. Contents, in order: shell spans when
  `shellSpans()` recognizes a known command head (each token in its kind
  color); else a path (`PATH_RE`) in `path` underlined; else `code` color.
  (Tinted pills with padding and Nerd Font caps were tried and rejected as
  noise; a tint alone is what none of the reference apps rely on.)
- Streaming: unclosed `` ` ``, `**`, `*`, `[` stay literal. Code colors
  apply on the closing backtick.

## Blocks

- Paragraph: `Box width M` holding one wrapping Text.
- Headings: H1 bold `heading`; H2 bold, one step from `heading` toward
  `meta` (0.4.20); H3 and deeper bold `heading3`. No
  rules, no `#`. Hierarchy comes from color and the blank line above.
  (A trailing rule was dropped with the full-width measure: a 188-cell
  rule is heavy, and the reference apps draw none.)
- Lists: markers `•` (top), `◦` (nested), `☐`, `☑`; `☑` in `ok`, the rest in
  `bullet`. Ordered numbers in `orderedNum`, padded to the widest marker.
  Items are `M - depth*2` wide, indented `depth*2`. Zero rows between items.
- Fence: a `blockBg` card, `paddingX 1`, sized to its widest line (floor
  60, cap M). Tabs expand to four spaces: the terminal skips a tab's
  cells without the tint and the engine counts it one cell. Header row only when the block exceeds 8 lines: `faint`
  uppercase language left, `faint` `N lines` right. The
  body is glass's own highlighter (`hooks/highlight.ts`): one row per
  line, keywords in `codeKw`, calls in `codeFn`, types in `codeType`,
  strings in `codeStr`, numbers and constants in `codeNum`, comments in
  `comment`; shell fences through `shellSpans`, in the prose keys, so a
  command reads the same in a fence and in prose; prose files and fences
  (`md`, `txt`, `rst`, `adoc`...) paint nothing, since a README diff is
  English. A `faint` gutter from
  line 1 once over 8 lines. A diagram draws as typed: a fence with no
  language (or `text`, `txt`, `ascii`, `diagram`) whose non-empty rows are
  at least half arrow, box-drawing, block or shape glyphs (U+2190 to
  U+21FF, U+2500 to U+25FF), or their ASCII stand-ins (`+--`, `|--`,
  `--+`, `-->`, `<==`, a row boxed in `|`, a connector row of `|` `v` `^`),
  has no header and no gutter, and its rows cut at the card edge
  (`truncate-end`) instead of wrapping. One-dash arrows (`->`, `=>`) and a
  diffstat's `+++---` are code's and never count. (The engine's
  `Code` paints with its own theme,
  which the owner rejected 2026-10-03; its `Markdown` leaf was tried
  next and dropped for the same reason.)
- Table: no vertical borders. Bold `bold` header, one `rule` row of `─`
  segments joined by two spaces, body rows joined by two spaces, cells
  padded with spaces measured by `cellWidth` (pills counted). Numeric
  columns right-align unless the separator names a side (`:--`, `--:`,
  `:-:`); a bare `---` names none. A table wider than `M - 2` (the quote's
  measure inside a quote) squeezes its widest column a cell at a time,
  down to 4, a squeezed cell cut in the middle as plain text; only a table
  too wide even then falls back to the engine's `Markdown` with the raw
  lines. The separator row must match the header's cell count; a bare
  `---` under a line with `|` is a rule. A table start interrupts a
  paragraph. Streaming reflows widths per committed row; jitter accepted.
- Quote: a `quoteBar`-colored `▎` on every row of the quote (the row count
  estimated from the engine's wrapping, as the Bottom line card does), one
  space, the inner blocks at `M - 2` with a blank row between them, no tint.
  (A dim `▌` half block drawn once per inner block was the first design: too
  thick, and the bar vanished on wrapped and list rows. Changed 2026-10-02.
  Box has no single-side border, so the bar is a glyph column.)
- Bottom line card: detection is monotonic. Once the head line is
  `**Bottom line**`, `**Bottom line**:` or `**Bottom line:**` the block is a card for the rest of the stream. Every
  following line, or the items of a list right after a title-only card, is
  a row; `Verified:`, `Issue:` and `Fix:` take their label and color, any
  other row gets a blank 8-cell label. Card = `Box backgroundColor blockBg`
  sized to its longest row (floor 60, cap M); a `calloutBar`-colored `▎`
  on every row, the row count from the same word wrap the engine applies.
  Compact: no padding rows and no blank rows. (Full padding plus a blank
  between every row was tried and judged too bulky; so was a blank after
  wrapped rows only.)
  The bold `calloutBar` title sits ABOVE the card as a plain line; only the
  labelled rows are inside the tinted box (title inside the box was the
  first design, moved out 2026-10-02 by request). Labels padded to 8 then
  two spaces; row text in `calloutText`, wrapping under itself.
- Rule: `─` repeated to min(M, 60) in `rule`.
- Raw html: the engine's `Markdown`.

## Tool rows

- Header row = a blank row above, status dot (`ok` green, `err` red on
  error or interrupt, `comment` while running), then `Tool(subject)` as one
  wrapping line, as the engine and claude-hl draw it: tool name in `tool`
  (rose), parentheses dim. Bash: the command tokenized with the head
  trusted, flowing on one line. (Breaking chained commands one per line was
  tried and reverted by the owner.) File tools: path in `path`; URLs
  underlined in `url`; other arguments dim after a comma.
- (Superseded by the second pass: every Bash body is glass's, under the
  trunk.) Bash result bodies of at most 3 lines are redrawn (`hooks/output.ts`,
  `renderToolOutput`): the dim `⎿` connector, then each line painted as
  claude-hl painted tool output: commands with evidence, paths and URLs,
  error, warning and success words, numbers and durations, check and cross
  marks, git status codes. Longer output keeps the engine's collapsed body
  and its ctrl+o expansion untouched. (Rewriting `output` with SGR codes
  was tried first: the engine strips them, nothing showed.)
- Reply text: a U+FE0F after a text-default symbol (U+26A0 and kin) is
  dropped, since the terminal draws the emoji form 2 cells while the
  engine counts 1 and the next character is drawn over.
- Open: in an expanded group (ctrl+o, `--verbose`) the engine draws the
  result inline in the `ToolUse` row; the header-only tree may drop it
  there. Verify live before adding any preview.

## Footer

- (Superseded: the footer line is gone, see the second pass.) Replaces `Baked for 12s`: `Box marginLeft 2 marginTop 1`, one dim line
  `12s · 3 tools · 322k ctx · 1.6k out · done 3:31 PM` (the finish time in
  the machine's locale, as the engine's own line had it). Tools omitted at zero, tokens
  omitted when unknown, the whole line hidden under 3s with no tools.
  Drawn from `$.state` `glass.turns` (the last 48 turns, written at `turn.complete`); a footer row finds its own turn by `durationMs`, since a state read in a render hook subscribes the row and every write redraws it.

## Palette

`tidepool` (default) maps the owner's nvim theme by role; `codex` and
`rose` carry claude-hl's sets. Every palette supplies the full `Palette`
type in `hooks/palette.ts`, the code keys (`codeKw`, `codeFn`,
`codeType`, `codeStr`, `codeNum`) and the diff tints (`addBg`, `delBg`)
included; tidepool's code keys are the engine's reply-fence colors the
owner liked (blue keywords, red strings, olive calls, pine types). Not ported from claude-hl, on purpose: the
inline-code background (`CLAUDE_HL_CODE_BG`, rejected as noise), the
foreground remap (the mod draws its own colors), the extra themes
(catppuccin, tokyonight, dracula, gruvbox, nord: add on request), and
`CLAUDE_HL_COMMANDS` vocabulary growth (edit `COMMANDS` in `hooks/shell.ts`).

The palette option follows `/config` live: a `config.set` hook on
`glass.palette` swaps the module's palette after the engine stores the
value, so the next row drawn takes the new colors (it was read once at
load before, 2026-10-03). Rows already on screen keep theirs.

## Verification

- `claude plugin validate .`, `npx -p typescript tsc -p .` (a bare `npx
  tsc` fetches an unrelated `tsc` package), the ASCII grep above.
- `claude plugin test .` runs `tests/*.test.ts`: width fixtures, glyph
  integrity, parser edge cases, streaming callout.
- Live in Ghostty after a reload: a prose pill, a pill in a table, a table
  with an emoji and CJK, the Bottom line card mid-stream, a `&&` Bash row,
  ctrl+o on a grouped row.

## Turn chrome (0.3)

The transcript drawn as the Empryo v3 desktop draws a turn, inside the
engine's row order. Reference: the X post of 2026-10-02 (video, 21s) and the
official desktop screenshot; Empryo's v3 transcript is not open source, so
every value below is read off the frames. Supersedes the `Tool rows` and
`Footer` sections above where they conflict; `Global` and `Blocks` stay.

Engine row order per turn, which glass cannot change: user row, then tool
rows and reply text blocks interleaved as the model made them, then the
`TurnDuration` line, then any task-notification rows. Empryo's order is
header, tree, prose, footer, events. The mapping below keeps the engine's
order and draws Empryo's chrome on the rows the engine already has.

### Hierarchy rule

One rule, as Empryo's: bright for the live thing, muted one step for the
done thing, faint for scaffolding, saturated color only on status marks.
Four text steps, all palette keys (no `dimColor` on colored text): `text`
(prose, as today), `meta` (times, counts, durations, args of a done row),
`faint` (connectors, folds, hints), and `bold`. `dimColor` has no site
left: the fence header moved to `faint` in 0.4.20.

### User row (`UserMessage`, origin `composer`)

- Above the row, a turn separator: a blank row, a `faint` rule M wide,
  another blank row (owner's request, 2026-10-03: prompts sat flush under
  the reply before).
- `◆ You · 01:11 PM` then the prompt, wrapped at M, indented 2 under the
  header. `◆` and `You` in `accentUser`, the time in `meta`. The time is
  the `prompt.submit` clock for that text (map text -> time, newest wins;
  a row with no match draws no time).
- Rows with other origins (`task-notification`, `peer`, ...) see the
  events bullet below; `isExpanded` false passes to the engine.
- The assistant header `◉ Claude · 01:14 PM` is drawn as the tail of this
  tree after one blank row: `◉` and the name in `accent`, the time in
  `meta` from `turn.start`'s clock, read from state so the row redraws
  when the turn begins (the footer's subscribe-and-redraw pattern). This
  is the one place a header can precede both tool rows and text blocks,
  since the engine fixes the row order. Drawn only once a turn has
  started for this prompt; a prompt that never ran a turn shows none.
- The reply bullet on the first text block (`isFirstOfReply`) is dropped:
  the header carries it. The first block keeps its blank row above.

### Tool rows: the tree (`ToolUse`, `ToolGroup`)

- Every main-loop tool row is one line of a tree: a connector, a status
  mark, the tool name, a dim subject, and a right-aligned duration.
  `├─ ✓ Bash  git log --oneline -1 · 3 lines                      0.8s`
  Connector `├─` in `faint` on every row. (The last call drew `└─` at
  first; the third pass dropped it, since knowing the last call needs a
  subscription to the turn.)
- Status mark: `✓` in `ok`, `✗` in `err` (errored or interrupted), `○` in
  `meta` while running. The dot of 0.2 goes away.
- Tool name in `tool`, bold while running, plain once done. Subject as
  today (Bash tokenized, paths in `path`, URLs in `url`) while running;
  once done a Bash command stays tokenized and every other subject,
  paths included, drops to `faint`. The subject wraps never: `wrap: 'truncate-end'` is allowed here
  alone, since ctrl+o shows the whole call. (This is a stated exception
  to the `Global` no-truncate rule, which protects reply text.)
- Only the subject gives way. The connector and mark sit in one box that
  never shrinks (`rowHead`), on tool, group, event and message rows alike:
  a long subject once squeezed the mark's cell and its gap with it
  (`○Bash  cat > …`, 2026-10-05).
- Right column: the call's wall time from `tool.call` (clock around
  `await next(e)`, keyed by `tool_use_id`, main loop only), formatted
  `0.8s`, `12s`, `1m 04s`, in `meta`; Bash adds `· N lines` before it in
  `faint` from the stored output. Layout: `Box row justifyContent
  space-between`, the right Text `flexShrink 0`.
- Hover: the row `Box` carries `hover: { backgroundColor: rowHover }`.
- Painted Bash output under a standalone row stays as today (3 lines max),
  indented under the subject at the connector's column + 3.
- `ToolGroup` (the engine's folded run of reads and searches) draws one
  tree row: `├─ ◉ +17 completed [3 edits] · ctrl+o to expand` all in
  `faint`, `◉` in `meta`. (A `Click to expand` Button was the first
  design; it never received its press live, dropped 2026-10-03.) A group
  with any errored or interrupted call opens on its own, so a red mark
  never hides behind a count. `/expand` sets `expandAllNow` and every
  group opens; `/collapse` clears it. There is no per-group route: no
  press reaches a transcript Button. (ctrl+o was reported not to open a group either, 2026-10-03;
  the commands are the route that does not depend on the engine's keys.) A group with any errored call adds
  `· N failed` in `err`. While `isActive`, the row ends in `…`.
- A `Button` never sits inside a `Text`: the validator refuses the tree
  (`Button inside an inline element`). No transcript row draws a Button
  now; the band's chevron is the one Button glass draws.
- (Superseded: the press never arrived, so the fold button went.) Verify live before shipping: that a `Button` inside a transcript row
  receives `ui.press` (the types say every surface; the mounted test only
  shows the tree validates). If it does not, the fold line is text and
  ctrl+o remains the way in.

### Footer (`TurnDuration`)

(Superseded by the second pass: `TurnDuration` draws `display: none`, and
the dots line carries the counts. Kept as history.)

- Line 1, the stats, `■` in `faint` then `meta`:
  `■ 2m 26s · 17 actions · 3 edits · 2 failed · $0.58 · 1.8M in · 5.3k out · 90% cached`
  Omitted when zero: actions, edits, failed. `failed` in `err` when
  present. Cost is the delta of `$.session.usage().cost.usd` taken at
  `turn.start` and `turn.complete`, formatted `$0.003` under a cent else
  two decimals; omitted when the host has no ledger. `cached` =
  `cache_read / (input + cache_read + cache_creation)`, in `ok` when
  >= 50%, else `meta` (Empryo's rule). `done 3:31 PM` leaves this line;
  the header above carries the time.
- Right end of line 1: a plain Button `Copy` (`$.ui.copy` of the turn's
  `answer` text stored at `turn.complete`), dim, lit by hover. `Fork` was
  dropped: no engine command to run was confirmed at build time. Same
  live check as the fold button.
- Counts: `actions` = main-loop `tool.call`s this turn; `edits` =
  `Edit`, `Write`, `NotebookEdit` calls across main loop and agents;
  `failed` = calls whose `ToolUse` ended errored or interrupted, counted
  from the `tool.call` result's `isError`.
- The hide rule stays: under 3s with no tools, `display: none`.

### Events after the turn (`UserMessage`, origin `task-notification`)

- Drawn as tree rows after the turn, same geometry as tool rows:
  `├─ ✓ Background agent finished · <summary>           1m 12s`
  `✓` in `ok` unless `task.status` reads as failed, then `✗` in `err`.
  Summary is `e.props.text`'s first line in `meta`; duration from
  `task.durationMs` when present, none under 100 ms. Every event row
  draws `├─`: knowing the last needs a subscription to the session's
  messages, as with tool rows. The row's hover key is the message's
  `requestId`, so two notifications with the same first line stay apart.
- `isExpanded` true (ctrl+o) passes to the engine, so the full text shows.

### Background band (`AbovePrompt`)

- Shown while any subagent runs; passed to the engine whenever
  `hasSurvey`. The band is one site for every plugin, so glass always
  calls `next(e)`: with no agent running it returns what the plugins
  beneath drew, and with agents its frame draws above that (PR #4,
  2026-10-05). A one-cell `accent` rail on the left (`▎` per row, as the
  quote bar), header `◌ background · N` with `N` in `accent` bold, the
  elapsed time of the oldest live agent at the right in `meta`.
- (Superseded by the second pass's rounded frame.) One row per live agent, newest last, at most 5, then `+N more` in
  `faint`: `◆ <description, truncated 18> · <model> · <stage>`. `◆` in
  `warn`, description in `bold`, model in `accent`, stage in `meta`. Stage
  is the last tool name that agent called (`tool.call` with its
  `agentId`), or `thinking…` with none yet. Per-agent tokens and cost are
  not in the API (usage lands only at that agent's `turn.complete`): no
  such column, by design, not omission.
- Agent identity: `agent.spawn` gives `tool_use_id`, `description`,
  `subagentType`, `model`; the `agentId` comes from awaiting `next(e)`
  there. Removed at `turn.complete` with that `agentId`.
- Sized to `bodyColumns`, never `viewport.columns`. Rows over `maxRows`
  scroll as the engine provides.

### Spinner

- `Spinner` draws `<word>… · N actions` while `mode` is `tool-use`, else
  the engine's line with the suffix untouched. One `Text`, `meta`.

### Past turns

- Deferred. Empryo dims every past turn and lifts it on hover. The API
  allows it (`Text.hover.dimColor` with a `scope` per message id), but the
  cost is one state read per text block so old blocks redraw at
  `turn.start`, and `dimColor` over colored spans is unverified in
  Ghostty. Try after everything above has shipped; drop if it flickers.

### Palette

- New keys in `Palette`, every palette supplies them: `meta`, `faint`,
  `rowHover`, `accentUser`, `text`. `tidepool`: `meta #7aa2b5`, `faint
  #48708c`, `rowHover #0e2a3a` (the blockBg), `accentUser #7bc0ae`, `text`
  unset (the terminal fg, as today).
- New palette `undertow`, read off the frames, so approximate: bg
  `#16171B`, `text #E7E6E9`, `bold #FFFFFF`, `meta #8A8D94`, `faint
  #52535C`, `accent #5EC8D8`, `accentUser #4FD1A0`, `ok #4FD1A0`, `err
  #E85C6B`, `warn #E8A04C`, `tool #5EC8D8`, `path #D6B477`, `rowHover
  #1E2024`, `blockBg #1C1E23`, the shell kinds from `codex`. Exact values
  need Empryo's `proxysoul-undertow` theme, which is not public.

### Glyphs

Added to `hooks/glyphs.ts`, by code point as the rule requires: `├`
U+251C, `│` U+2502, `✓` U+2713, `✗` U+2717, `○` U+25CB, `◉` U+25C9, `◆`
U+25C6, `◌` U+25CC, `▸` U+25B8, `▾` U+25BE. Each gets a `cellWidth`
fixture. (`└` and `■` went with the elbow and the footer; `glyphs.ts`
holds only glyphs the mod draws.)

### State

`glass.turns` grows: `turnId`, `startedAt`, `answer`, `edits`, `failed`,
`cacheTokens`, `costUsd`, `lastToolId`. The atoms, all under `plugin:
'glass'`: `turns`, `prompts` (text, submit and start times, turn id; last
48), `calls` (turn id -> main-loop calls with status and wall time; last
48 turns), `agents` (live subagents), `band` (`open` or `closed`). See
the second pass below for what each draws. `/fold` and `/expand` are
module state (`foldedTurns`, `expandAllNow`), which a render hook reads
without subscribing; a hot reload opens everything again. The module
records (call -> turn, call -> wall time, a turn's call order, unfolded
group calls) keep the last 48 turns, as the atoms do.

### Not drawn, and why

- HISTORY folding of old turns: the engine owns transcript folding.
- Side call rows, `Effort: auto → xhigh` rows, per-agent cost: Empryo
  internals with no event or field in this API.
- Icons per tool kind: the ASCII rule and font variance; the tool name in
  `tool` color is the icon.
- `Review` and `Till pass` footer actions: product features, not drawing.

### Verification

- `claude plugin test .`: a mounted render of each new tree (user row with
  header, a tree row running and done, a group fold, the footer with every
  field, the band with 6 agents), width fixtures for the new glyphs.
- (Superseded in part: no fold button, footer or `└─` remains.) Live in
  Ghostty: the fold button press, the footer buttons, a `└─` on the last
  row after `turn.complete`, hover on a tree row, the band under
  5 Agent calls, a task-notification row, a 190-column resize.

### Second pass: the Empryo turn pattern (2026-10-02, after the first live look)

The first build drew the tree open under every turn. Empryo folds a
finished turn; these rules replace the ones above where they differ.

- The dots line. Under the assistant header, indented 2: one dot per
  main-loop call in call order, grouped by consecutive tool with a space
  between groups, `ok` green, `err` red, hollow in `meta` while running;
  then two spaces and the summary in `bold`. (A chevron Button and a
  `⧉ Copy` Button were here; both went, see below and the fourth pass.)
  Folded (`▸`): the tools in first-seen order with counts, `Bash ×3 ·
  Read ×2`. Unfolded (`▾`): `17 actions · 3 edits · 2 failed`. Drawn only
  for turns glass saw start (`prompts[].turnId`).
- Folding, on demand only (owner's call, 2026-10-03: a finished turn
  folded by itself at first, and the chevron Button never received its
  press live, so the tree was a one-way door). Every turn's tree stays
  open. `foldedTurns` holds the turn ids `/fold` tucked away (every finished
  turn in `turns` at that moment); `/unfold` empties it; a new turn
  leaves it at `turn.start`. A folded turn's `ToolUse`, `ToolGroup` and
  `ToolResult` rows draw `display: none`; rows of calls glass never
  recorded (an earlier session, a reload) stay visible. The dots line
  has no chevron: tool counts while live, the totals once done. `calls` records every main-loop
  call under its turn with status and wall time; the tree's duration
  column reads it (the `times` atom is gone).
- The footer line is gone (owner's request, 2026-10-03): the engine's
  `TurnDuration` row draws `display: none`; the dots line carries the
  counts; cost and tokens stay in `turns` for later. A done
  tree row steps everything after the tool name to `faint`, paths and
  the duration included (same request).
- (Superseded.) Footer actions, from the left: `◎ Review`, `↻ Till pass`, `⑂ Fork`,
  `⧉ Copy`. The first three fill the prompt with `/code-review `, `/loop `
  and `/fork ` through `$.prompt.fill`, and each shows only when
  `$.command.list()` at `session.start` has that command. The action
  counts moved to the dots line; the footer keeps time, cost and tokens.
- The band is a rounded frame the band wide, drawn with arc and rule
  glyphs since a border cannot carry a title: top edge `╭─ ◌ background ·
  N ▾ ─── 1m 25s ─╮`, one row per agent `│ ◆ (●‿●) name  model · effort
  stage  tokens  file │` in fixed columns (20, 22, 14, 8, the rest), `+N
  more`, bottom edge `╰─ They outlive this turn ─── /tasks ─╯`. The face
  smiles while the agent thinks and lowers its eyes while it runs a tool.
  Tokens are the sum of the agent's `turn.step` usages, read off each
  stop chunk; `turn.step` streams, so its hook is an async generator that
  relays every chunk. Effort is the step's. The chevron closes the frame
  to one strip: `─ ◌ background · N ▸ ─ (●‿●) (●▾●)  name · stage ───
  1m 25s ─`, measured from its own strings so it is exactly the band
  wide. Per-agent cost stays out (no price table in the API).
- Air between rows (owner's request, 2026-10-03): every tree row (tool,
  group, event, message) draws one row above itself holding only the
  trunk `│` in `faint`, so runs read apart and the tree stays one line.
  Tree rows and their bodies sit 2 cells in from each edge (`TREE_INSET`),
  so the right column ends where the prose measure ends, never on the
  terminal's edge (same request).
- The trunk is concrete (owner's request, 2026-10-03: the `⎿` connector
  and the engine's collapsed body left the line in pieces). Every body
  row under a tool row (`trunked`) carries `│` in `faint` down a 3-cell
  column, one row tall (output lines clip to one row since 0.4.1), the
  content under the mark. Every Bash result is glass's: stdout and stderr painted for
  the first 3 lines, the rest `… +N lines`; a failed command's text the
  same way with its error words in `err`; a file-changing one as below; one
  that printed nothing as a single `faint` `(No output)` line (2026-10-06:
  the engine's own body drew its corner bracket off the trunk). The
  engine keeps only interrupted results and raw escape-coded output. (A
  blank column under the turn's last row went with the elbow.) The trade: a long result's ctrl+o expansion is no
  longer the engine's collapsed body; verify live whether the verbose
  transcript still shows the whole output.
  The painted Bash body sits at the engine's own column (`marginLeft 2`,
  where the engine draws its `⎿` for long output) and its unpainted text
  is `private`, the color of a Privately note; `Message from @agent` rows
  take `private` too.
- An Edit's or Write's result (owner's request, 2026-10-03, after
  Empryo's card): `structuredPatch` drawn by glass in place of the
  engine's diff panel. A rounded `faint` frame ON the trunk column
  (`marginLeft TREE_INSET`), so its own left border is the trunk for
  exactly the card's height, wrapped rows included, and the arcs read as
  the line flowing in and out (a glyph column beside the card was the
  first design and came up short beside wrapped rows, 2026-10-03). Sized
  to the hunks (floor 60, cap `columns - 2 * TREE_INSET`), `paddingX 1`. One
  number column in `faint`: the new number on a kept or added line, the
  old on a removed one. `+` in `ok` on an `addBg` row, `-` in `err` on a
  `delBg` row; the tints are not green and red but the band tint and a dim
  plum, so the marker and its color carry the meaning for colorblind
  readers (owner's pick, 2026-10-03, after Empryo's row band); the code painted by the highlighter with the language from
  the path, an ellipsis row between hunks. Past 200 rows the rest folds to
  `… +N lines (ctrl+o to expand)`.
- A Write that created its file has no patch (`type: 'create'`): its
  whole `content` draws as added lines under the title `Created <path>`.
  Rows of a group the engine unfolded raise no `ToolResult`, so the
  `ToolUse` hook draws an Edit's or a Write's card under such a row
  (PR #3, 2026-10-05).
- A Bash result whose command rewrote files (`bashEditDiff` on the
  result) is drawn whole by glass, since the engine's panel for it was the
  last pink thing: the output body painted as a short one is, folded past
  3 lines to a `faint` `… +N lines`, then per file one row of air, a
  header `Updated <path> +a -b` (`Created`, `Deleted` by the flags; verb
  in `meta`, path in `path`, counts in `ok` and `err`) and the Edit diff
  card. `moreFiles` ends it as `… +N more files`. Trade accepted: that
  body loses the engine's ctrl+o expansion of the long output.
- Loader rules learned live: a helper that takes `$` must be a function
  declared at the top of the module, not a closure inside `register`;
  a streaming event's hook must be `async function*`; a `Box` with a
  `hover` style must carry a `key`, or the validator refuses the tree and
  the engine draws its own row (this hid the event rows for two demos).

### Third pass: the demo's density (2026-10-03, after the design panel)

- Paths under the session's directory draw relative (`SPEC.md`): `$.session.cwd()`
  read at `session.start`, applied in tree subjects, group rows, diff titles.
- The diff card names its file in its top border, `╭─ SPEC.md +1 -1 ───╮`
  (`Created`/`Deleted` before the path when so). glass draws the frame itself,
  row by row: no Box border. It breaks every code line at the card's room by
  the engine's ruler (mid-word, as delta does), so the engine never wraps
  inside the card and every row carries its own two edges; the text Box is
  `truncate-end` as a guard only. This answers the old objection to a glyph
  frame (a side column came up short beside wrapped rows): no row wraps.
  Tabs expand to four spaces. The `Updated <path> +a -b` header row under a
  Bash edit goes; a file with no hunks keeps it. One context line before a
  hunk's first change and one after its last; context between changes stays;
  the numbers keep counting. (Tried first, 2026-10-03: an absolute Text over
  a Box border. At `top: -1` it was clipped, at `top: 0` it covered the first
  code row: the engine counts offsets from inside the border and never lets a
  child paint the border row. Then the title as the first row inside the
  frame, which the owner found plain.)
- A folded group names what it touched: the tools with counts in `tool`, then
  each subject once. `ctrl+o to expand` goes (it never opened a group live).
- A finished agent is one row: `✓ Agent  <description>` with its duration in
  `faint`. The folded `Message from @<type>` row of a subagent this session
  spawned draws `display: none`; ctrl+o still shows it, and a peer's stays.
- Unpainted Bash output draws in `meta`, apart from the `faint` scaffolding.
- `water`: `rule #5a5870` (was 1.69:1 and vanished), `delBg #33222e`.
- Tree rows (`ToolUse`, `ToolResult`, `ToolGroup`) read no atom (2026-10-03):
  a read in a render hook subscribes the row, so each call's state write
  redrew every row of the turn and stranded duplicate rows above the
  viewport. They read module records (call -> turn, call -> wall time, folded
  turns, /expand) written in the hooks; /fold, /unfold, /expand, /collapse
  call `$.ui.invalidate('ui.render')`. The `└─` elbow goes: knowing the last
  call needs that subscription. A hot reload empties the records until the
  next turn. The user row's dots line still subscribes (one row).
- A single quote opens a string only at a word's start, and an apostrophe
  between two letters never closes one (2026-10-03: `diff card's frame ...
  card's room` in a commit message painted `diff` as a command and the
  rest as a string). Real shell quotes paint as before.

### Fourth pass (2026-10-04, the panel's remaining visual proposals)

- The turn boundary is one titled rule: `◆ You · 3:20 PM ───` in `faint` to
  the measure, a blank row above, none below. It replaces the bare rule
  with a blank row each side (two rows saved per turn).
- The dots line: a failed call's dot is `✗` in `err`; a live line appends
  `· N failed`; a done turn's summary steps to `meta`. The `⧉ Copy` Button
  goes (it never received a press); the engine's own `/copy` copies the
  last reply.
- A folded group's mark is `▸` in `meta`; `◉` is the Claude header's alone.
- On a tinted diff row the gutter number is `meta`, not `faint`.
- A fence under nine lines draws no header row; from nine lines the header
  keeps the language and the line count.

### 0.4.1 (2026-10-04, from the live check of 0.4.0)

- Air: every tree row keeps its trunk row above, except a bare row that
  continues a run of the same bodiless tool (`Read`) with no prose between
  (`turn.step` text chunks mark prose). A row after a body, a card, prose,
  an Agent line or another tool always has air.
- A Bash body draws under its ToolUse row from the row's own `output`; the
  ToolResult row then draws nothing. Calls run in parallel drew their row
  with no ToolResult, so the body went missing (live, 2026-10-03).
- Output lines clip to one row each (`truncate-end`); ctrl+o has them whole.
- No duration under 100 ms (`0.0s` said nothing).
- A folded group names a Bash call by its command, clipped to 60 cells.
- A backgrounded Agent's or Bash command's result is one trunked `faint`
  line, `running in the background · ↓ to manage`, in place of the
  engine's body, whose corner bracket broke the trunk (Bash since 0.4.12).
- A failed call other than Bash (an Edit whose string was not found) draws
  its reason's first line in `err` on the trunk, the rest a `faint`
  `… +N lines`, in place of the engine's `Error editing file` and its
  corner bracket (0.4.17, confirmed live 2026-10-06). The `[Image #N]` row
  under an image prompt is still the engine's and keeps its bracket.
- A loaded skill's result is one trunked `faint` line, `skill loaded`, with
  the engine's `N tools allowed` and model after middots where it gives
  them; a forked skill draws as an Agent's launch. In place of the engine's
  `Successfully loaded skill` and its corner bracket, which sat off the
  trunk (0.4.25, owner's screenshot 2026-10-09). Unverified live.
- The band stops four cells short of `bodyColumns`, so the engine's `[-]`
  mark sits beside its top-right arc, not over it. Unverified live.

### 0.4.2 (2026-10-04): live things

- Running rows tick. While a main-loop call runs, the row's right column is
  a `Raster` keyed `clock`, 7 cells, the elapsed time in `meta` right-aligned
  (`fmtDuration`; from an hour on `2h 05m`, so seven cells hold it whole). One ticker, `$.clock.every(1000)`, blits every running
  call's clock by its `tool_use_id` (`RasterBlitArgs.requestId` names a tool
  row as a site): no redraw, no state write. It starts at the first live
  call or agent and cancels itself once nothing runs. Unverified live:
  whether the validator accepts a Raster in a transcript row; a refused tree
  would put the engine's own row back.
- (Removed in 0.4.6, owner's request: noise under the prompt.) A status
  line under the prompt (`$.ui.status`) said what ran, `Bash 12s · 2 agents
  1m 04s`. The ticker now only blits running rows' clocks; `session.start`
  clears a status line a reload left behind.
- A call's dot on the dots line and its tree row share a hover scope
  (`glass:<tool_use_id>`): the pointer on either lights both with the same
  `rowHover` tint; the dot keeps its own color (an inverted dot was tried
  and rejected, 2026-10-04: a red block that matched nothing). The dots are sibling Texts in a Box row,
  since a Text nested in a Text follows a hover group but cannot heat it.

### 0.4.4 (2026-10-04): the hint line under the prompt

- The engine's hint loses its key reminders, `(shift+tab to cycle)` and
  `· ← for agents` (owner's request: keep the line under the prompt clean).
  What stays, vim mode first wherever the engine put it (live, the hint
  reads `⏵⏵ auto mode on · -- INSERT --`): `-- INSERT --` in `accentUser`,
  then the permission mode by meaning, auto and bypass `warn`, plan `accent`,
  accepting edits `ok`, else `meta` (owner's request: the glass palette). A hint with
  nothing to drop (`? for shortcuts`, `esc to interrupt`) keeps the engine's
  own line and its live pills. A rewritten line is glass's Text, so the
  pills there are no longer the engine's. Unverified live: that the hint
  string carries `-- INSERT --` as the screen shows it.
- Order, live: once a hook rewrites the hint, the engine draws its mode pill
  first, then `·`, then glass's text, so the line reads `⏵⏵ auto mode on ·
  -- INSERT --`. The mode's color is the engine's; glass colors only its
  own text. The owner accepted INSERT after the mode for the cleaner line
  (2026-10-04, after 0.4.7 tried the engine's own line again).
- Merging the line into the owner's status line is out of glass's reach: the
  status line is the owner's own script (settings `statusLine`).

### 0.4.9 (2026-10-04): diagrams in fences (PR #2, Sarthak Jha)

- A fence diagram draws as typed: no header row, no gutter, rows cut at the
  card edge. A wrapped row broke every box and arrow below it, and a
  gutter numbered a picture.
- A quote's bar counts a fence header only when one is drawn. Since 0.4.0
  a short fence with a language drew no header but the bar still counted
  one, so it hung a row below the quote.
- Real code is unchanged, and a `text` fence of prose with a stray arrow
  stays text.

### 0.4.10 (2026-10-04): one fence shape, ASCII diagrams

- `fenceShape` works out what a fence draws (diagram, gutter and header,
  card width) once, for both the card and the quote bar's row count, so the
  two cannot drift again. The bar now also counts a code line that wraps:
  a quoted fence with a long line drew its bar short.
- Plain ASCII diagrams draw as typed, like the Unicode ones (see Fence).

### 0.4.18 (2026-10-06): tabs in fences

- A fence's tabs expand to four spaces, as in diff cards. A tab-indented
  line drew its indent in the page color, not the card's `blockBg`, and
  the card's width counted each tab as one cell.

### 0.4.19 (2026-10-06): audit fixes

- The documented checks run as written on macOS: `npx -p typescript tsc
  -p .` and `LC_ALL=C grep -rn '[^ -~]' hooks/`. tsc passes again.
- A numeric table column right-aligns when its separator names no side.
- `**Bottom line:**` (colon inside the bold) forms the card.
- The band's rows fit their frame on any terminal: from 84 columns as
  before; narrower, the file column goes first, then the model, the name,
  the tokens and the stage give up cells. The closed strip drops its
  oldest faces. `clip` to zero cells draws nothing, not a stray `…`.
  Unverified live.
- Durations from an hour on read `2h 05m`, in the clock and the tree. Past
  99h 59m the clock holds there.
- A Bash output line is cut to 1000 characters and loses its control
  characters before it is painted: a minified JSON line or a stray bell
  got the whole tree refused. A carriage return starts the line over, as
  a terminal does, so a progress bar shows its last pass.
- A comment-only line in a shell fence draws in `comment`.
- A quoted Bottom line or table: the quote bar asks the same width
  question the card and the table do, so it no longer drifts below 62
  columns. An over-wide table inside a quote is the engine's Markdown,
  whose height glass estimates as it does raw html.
- Dead code out: the Copy button and `onCopy`, the per-group expand route
  and its `expanded` atom, the never-read `folded` and `expandAll` atoms,
  the reply bullet, the `last` options and the elbow, `turnOf`, `rowsOf`,
  and glyphs only the tests used.
- A finished reply's parse is kept (the newest 64 by text), so `/fold`,
  resizes and palette changes do not parse every reply again. Links, URLs
  and code words are matched in place instead of copying the rest of the
  line each time.
- Known limit: a reply tree past the engine's 100,000 serialized
  characters is still refused whole and drawn by the engine.

### 0.4.20 (2026-10-06): the visual audit, first half

- A shell fence paints with the prose keys: a command, flag, string or
  operator reads the same in a fence as in backticks. (The fence mapped
  them onto the code keys, so `--force` and `|` drew differently.)
- A table a few cells too wide squeezes its widest column, down to 4
  cells, the cell cut in the middle, before it falls back to the engine's
  boxed Markdown. The quote bar counts the squeezed table as glass draws it.
- The fence header draws in `faint`, not the terminal's `dimColor`, which
  lands on a different step per terminal theme.
- H2 sits one step under H1, toward `meta`, so section levels survive in a
  long reply.
- Paths cut in the middle keep the file name, `hooks/...render.ts`: the
  band's file column and the diff card's title. The band's file draws
  relative to the session's directory, as tree rows do (it drew the
  whole home path). Tree subjects still cut at the end: the engine
  truncates them.
- The dots line past 16 calls draws the first 12 dots and `+N` in `faint`;
  45 calls had filled 80 columns and pushed the summary off the row. The
  summary keeps every count, failures included.
- Left for later, each its own decision: the gutter mark's color, the event
  rows' mark, and inline code's hue (it matches numbers in three palettes).

### 0.4.21 (2026-10-06): the gutter mark in warn

- The gutter mark takes each palette's `warn` (gold): it asks the reader to
  look, so it is not `ok`'s "done". In water its teal was the quote bar's,
  and in rose its foam was both bars', the same `▎` in the same color, so
  a marked paragraph read as a one-line quote. A test keeps `mark` apart
  from `ok`, `quoteBar` and `calloutBar` in every palette.

### 0.4.22 (2026-10-07): the audit's edge cases

- The width ruler follows Bun 1.3's `stringWidth` where it drifted: a
  grapheme sums per code point, so an Indic conjunct is two cells; marks
  (Mn, Me, Mc) and the invisible formats (ZWJ, ZWNJ, bidi marks, BOM, tags)
  are nothing, a soft hyphen and a word joiner a cell; a VS16 lifts a
  one-cell Emoji-property base (a digit, `#`, `*`, a text-default symbol)
  to two; a keycap is one; a jamo vowel or tail after its head is nothing;
  the wide table gains vertical and small forms, kana and jamo supplements,
  Tangut, the enclosed ideographic block. A sweep of every code point
  against Bun leaves only code points Bun's own tables predate.
- A fence indented under a list item (`1. Run:` then a fenced block) is the
  item's own `blocks`: drawn as a card under the item's text, in from the
  marker, as wide as the text at most; a quote bar counts its rows. It drew
  as inline code with newlines in it before. A fence at the margin still
  ends the list.
- `![alt](src)` draws as the link its alt text names, the bang gone; a link
  with a title, `[a](href "title")`, keeps the title out of the text.
- The gutter mark reads prose only: a `?` inside backticks (`foo?.bar`) or
  in a link's target never marks the paragraph.
- Paths: router segments in balanced brackets (`app/[id]/page.tsx`,
  `app/(auth)/layout.tsx`), extensions by any case (`file.PNG`), more of
  them (`vue`, `svelte`, `mdx`, `tf`, `jsonc`, `ps1`, fonts, media ...), and
  the conventional names (`Makefile`, `Dockerfile`, `Gemfile` ...) with
  their case.
- A numeric table column counts a sign, a currency mark, a percent or a
  short unit (`-3`, `$12`, `1.5k`, `12ms`), ignores empty cells, and its
  header sits over its numbers (it stayed left before).
- A blank line in a fence is one space, so its row is drawn whatever an
  empty Text measures. Unverified live whether it ever vanished.

### 0.4.23 (2026-10-07): MCP tool names

- An MCP tool (`mcp__<server>__<tool>`) draws as its server in `meta`, a
  space, then the tool name in `tool`: `figma get_design_context`. The
  server drops the `plugin_<plugin>_` and `claude_ai_` prefixes and a
  trailing `_MCP`, and reads lowercase with hyphens (`chrome-devtools`,
  `claude-docs`). A run of underscores in any tool name draws as one.
  Tree rows, the dots line's counts and the band's stage all use it.
- A `ToolGroup` row names a server once at its head. Calls to more than one
  server take a line each under one hover, the built-in tools on a line of
  their own, in first-seen order; a live group's `N running...` sits on the
  lines with a running call.
- Underscores stay: the name keeps one unit, apart from its subject, and
  matches what permission rules and logs show (owner's choice over spaces).

### 0.4.24 (2026-10-07): the MCP server steps down

- An MCP tool's server draws in `faint`, the subject's tone, not `meta`:
  on water `meta` sat one step above the path after it, nearly prose. Only
  the tool name keeps a color; a palette hue on the server was turned down
  as a second colored word beside the name.
