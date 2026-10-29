// Draws a parsed reply as an element tree, following SPEC.md: full-width
// prose, one rhythm rule, color-only inline code, two content-fit tinted
// cards, one glyph family (see glyphs.ts), one width ruler (see width.ts).
import type { Elements, RenderElement, RenderNode } from 'claude-code'

import { G } from './glyphs'
import { codeColor, highlight } from './highlight'
import { inlineText } from './markdown'
import type { Align, Block, CalloutRow, Inline, ListItem } from './markdown'
import type { Palette } from './palette'
import { bareWord, isUrl, pathLike } from './paths'
import { isPrivateNote, needsAttention } from './prose'
import { proseSpans, shellSpans } from './shell'
import type { SpanKind } from './shell'
import { cellWidth, clipMiddle } from './width'

type Table = Elements['terminal']

type Ctx = {
  t: Table
  p: Palette
  /** the prose measure in cells */
  m: number
  /** a color for plain prose, when the block mutes it (a quote's `meta`) */
  tone?: string
}

export type RenderOptions = {
  /** the first text block of a reply: keeps a blank row above */
  first?: boolean
  columns: number
  /** gutter marks beside paragraphs that need the reader; off when the prompt asked for writing */
  marks: boolean
  /** a compaction summary (0.5.0): one faint ` . summary` row closes the reply, as the engine's own mark reads */
  summary?: boolean
}

const LABEL_WIDTH = 8
const LABEL_COLOR: Record<string, keyof Palette> = {
  Verified: 'verified',
  Issue: 'issue',
  Fix: 'fix',
}
// the prompt tip's labels are three wide, so its column is too
const TIP_LABEL_WIDTH = 3
const labelWidth = (tone?: 'tip') => (tone === 'tip' ? TIP_LABEL_WIDTH : LABEL_WIDTH)

// the API bounds a Text or Code string at this many characters
const MAX_TEXT = 10000

// A run as strings the API takes: past MAX_TEXT characters it goes as
// several, side by side in the same Text, so it draws the same. A cut
// never splits a surrogate pair.
function cut(s: string): string[] {
  if (s.length <= MAX_TEXT) return [s]
  const out: string[] = []
  for (let i = 0; i < s.length; ) {
    let end = Math.min(s.length, i + MAX_TEXT)
    const last = s.charCodeAt(end - 1)
    if (end < s.length && last >= 0xd800 && last <= 0xdbff) end--
    out.push(s.slice(i, end))
    i = end
  }
  return out
}
// a tinted card never gets narrower than this
const CARD_MIN = 60
// how far H2 steps from the heading color toward `meta`
const H2_STEP = 0.4
// a table column squeezed to fit never gets narrower than this
const COL_MIN = 4
// a table cell that reads as a number: an optional approximation mark, sign
// or currency mark, digits with separators, then a percent, a multiplier or
// a short unit, with a per-unit tail (`1.5k`, `12ms`, `3GB`, `4.5MB/s`, `~2x`)
const NUMERIC_RE = new RegExp(
  '^[~<>' + String.fromCodePoint(0x2248) + ']?[-+]?[$' + String.fromCodePoint(0xa3, 0x20ac) + ']?\\d[\\d.,]*(?:%|' + String.fromCodePoint(0xd7) + '|[A-Za-z' + String.fromCodePoint(0xb5) + ']{1,4}(?:/[A-Za-z]{1,3})?)?$',
)
// a cell that stands for no value: it decides nothing, as an empty cell does
// not (one dash in a column of numbers flipped the whole column left)
const PLACEHOLDER_RE = new RegExp('^(?:-|' + String.fromCodePoint(0x2013) + '|' + String.fromCodePoint(0x2014) + '|n/a|N/A|\\?|' + String.fromCodePoint(0x2026) + ')$')

// a color `k` of the way from `a` to `b`; a non-hex color stays `a`
function blend(a: string, b: string, k: number): string {
  const hex = /^#[0-9a-f]{6}$/i
  if (!hex.test(a) || !hex.test(b)) return a
  const ch = (s: string, i: number) => parseInt(s.slice(1 + 2 * i, 3 + 2 * i), 16)
  return '#' + [0, 1, 2].map(i => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * k).toString(16).padStart(2, '0')).join('')
}

// inside backticks a path needs a slash or a `:line` suffix:
// `hooks/render.ts:88`, `src/main.rs`, `~/.zshrc`; not `shell.ts`
const PATH_RE = /^(?:~|\.{1,2})?[\w.-]*(?:\/[\w.-]+)+\/?(?::\d+(?::\d+)?)?$|^[\w.-]+\.\w+:\d+(?::\d+)?$/

export function measure(columns: number): number {
  return Math.max(20, columns - 2)
}

// the words of a run of inlines: code spans and link targets left out, so a
// `?` in `foo?.bar` or in a URL's query never marks the paragraph (0.4.22)
function proseText(inlines: Inline[]): string {
  return inlines
    .map(n => (n.kind === 'text' ? n.text : n.kind === 'code' || n.kind === 'link' ? ' ' : proseText(n.children)))
    .join('')
}

// cells a run of inlines takes once drawn
function inlineWidth(inlines: Inline[]): number {
  return inlines.reduce((n, node) => {
    switch (node.kind) {
      case 'text':
      case 'link':
      case 'code':
        return n + cellWidth(node.text)
      default:
        return n + inlineWidth(node.children)
    }
  }, 0)
}

// a card hugs its content: the widest row plus padding, floored, capped
function cardWidth(m: number, content: number): number {
  return Math.min(m, Math.max(CARD_MIN, content))
}

export function renderReply(t: Table, blocks: Block[], p: Palette, o: RenderOptions): RenderElement {
  const c: Ctx = { t, p, m: measure(o.columns) }
  const rows: RenderElement[] = []
  let prev: Block['kind'] | null = null
  blocks.forEach((b, i) => {
    const el = renderBlock(c, b)
    // one rhythm rule: a blank above every block except the first and any
    // text block right under a heading; the reply's first block keeps a
    // blank, so it never sits glued to the tool rows above. No bullet: the
    // assistant header under the user row carries it. A card, a table or a
    // Bottom line keeps its blank under a heading: a tint or a second bold
    // row glued to the heading read as one crowded block.
    const tight = prev === 'heading' && b.kind !== 'code' && b.kind !== 'table' && b.kind !== 'callout'
    const marginTop = i === 0 ? (o.first ? 1 : 0) : tight ? 0 : 1
    // a paragraph that asks something of the reader gets a gutter mark in
    // the two cells every other block leaves blank
    const marked = o.marks && b.kind === 'paragraph' && !isPrivateNote(inlineText(b.inlines)) && needsAttention(proseText(b.inlines))
    if (marked) {
      rows.push(
        t.Box({
          flexDirection: 'row',
          marginTop,
          children: [t.Text({ color: p.mark, children: [G.mark + ' '] }), t.Box({ flexDirection: 'column', flexGrow: 1, flexShrink: 1, children: [el] })],
        }),
      )
    } else {
      rows.push(t.Box({ flexDirection: 'column', marginLeft: 2, marginTop, children: [el] }))
    }
    prev = b.kind
  })
  // a compaction summary ends on its own faint mark, as the engine's does
  if (o.summary) rows.push(t.Box({ flexDirection: 'column', marginLeft: 2, children: [t.Text({ color: p.faint, children: [G.middot + ' summary'] })] }))
  return t.Box({ flexDirection: 'column', children: rows })
}

function renderBlock(c: Ctx, b: Block): RenderElement {
  const { t, p, m } = c
  switch (b.kind) {
    case 'paragraph': {
      // Claude's own planning note, drawn italic in a quiet color so the
      // real answer stands out
      if (isPrivateNote(inlineText(b.inlines))) {
        return t.Box({ width: m, children: [t.Text({ wrap: 'wrap', italic: true, color: p.private, children: cut(inlineText(b.inlines)) })] })
      }
      return t.Box({ width: m, children: [t.Text({ wrap: 'wrap', children: renderInlines(c, b.inlines) })] })
    }
    case 'heading':
      return t.Text({
        bold: true,
        // H2 one step under H1, toward `meta`, so section levels survive a long reply
        color: b.level >= 3 ? p.heading3 : b.level === 2 ? blend(p.heading, p.meta, H2_STEP) : p.heading,
        children: renderInlines(c, b.inlines),
      })
    case 'code':
      return renderFence(c, b.lang, b.source)
    case 'list':
      return renderList(c, b.items)
    case 'rule':
      return t.Text({ color: p.rule, children: [G.rule.repeat(Math.min(m, CARD_MIN))] })
    case 'raw':
      return t.Markdown({ text: b.text.slice(0, MAX_TEXT) })
    case 'quote':
      return renderQuote(c, b.blocks)
    case 'table':
      return renderTable(c, b.header, b.align, b.rows, b.raw)
    case 'callout':
      return renderCallout(c, b.title, b.rows, b.tone)
  }
}

// a fence with no language (or a plain-text one) whose rows are mostly
// arrows, box-drawing, block or shape glyphs, or their ASCII stand-ins, is
// a picture, not code
const DIAGRAM_LANGS = new Set(['', 'text', 'txt', 'ascii', 'diagram'])

function isDrawingGlyph(code: number): boolean {
  return (code >= 0x2190 && code <= 0x21ff) || (code >= 0x2500 && code <= 0x25ff)
}

// the same pictures drawn in plain ASCII: a corner or tree branch (`+--`,
// `|--`, `` `-- ``), a line into a corner (`--+`), a two-dash arrow (`-->`,
// `<==`), a row boxed at both ends, or a connector row of `|`, `v`, `^`.
// One dash is code's (`->`, `=>`), so it never counts, nor a corner after a
// `+` (a diffstat's `+++---`)
const ASCII_DRAWN = [
  /(?<!\+)[+|`\\][-=]{2,}/,
  /[-=]{2,}[+|]/,
  /<[-=]{2,}|[-=]{2,}>/,
  /^\s*\|.*\|\s*$/,
  /^[\s|v^]*[|v^][\s|v^]*$/,
]

function isDrawnRow(row: string): boolean {
  return [...row].some(ch => isDrawingGlyph(ch.codePointAt(0)!)) || ASCII_DRAWN.some(re => re.test(row))
}

function isDiagram(lang: string, source: string): boolean {
  if (!DIAGRAM_LANGS.has(lang.toLowerCase())) return false
  const rows = source.split('\n').filter(l => l.trim() !== '')
  const drawn = rows.filter(isDrawnRow).length
  return rows.length > 0 && drawn * 2 >= rows.length
}

// what a fence draws, worked out once for renderFence and blockRows so the
// quote bar cannot drift from the card (0.4.0 dropped the short header in
// renderFence alone, and the bar ran a row long until 0.4.9)
interface FenceShape {
  code: string
  lines: string[]
  diagram: boolean
  gutter: boolean // the numbered gutter and the header row, past 8 lines
  digits: number
  width: number // the card, padding included
}

function fenceShape(lang: string, source: string, m: number): FenceShape {
  // tabs expand here: the terminal jumps a tab without painting the card's
  // tint, and the engine counts it as one cell (as renderDiff does)
  const code = source.replace(/\n$/, '').replace(/\t/g, '    ')
  const lines = code === '' ? [] : code.split('\n')
  const diagram = isDiagram(lang, code)
  const gutter = !diagram && lines.length > 8
  const digits = String(lines.length).length
  const widest = Math.max(0, ...lines.map(cellWidth))
  const header = cellWidth(lang) + (gutter ? cellWidth(`${lines.length} lines`) + 2 : 0)
  const width = cardWidth(m, Math.max(widest + (gutter ? digits + 2 : 0), header) + 2)
  return { code, lines, diagram, gutter, digits, width }
}

// rows a fence draws: the header, then a row per line, more where a code
// line wraps (its indent counts, the engine keeps leading spaces); a
// diagram's rows are cut, never wrapped
function fenceRows(s: FenceShape): number {
  const text = s.width - 2 - (s.gutter ? s.digits + 2 : 0)
  const wrapped = (l: string) => wrappedLines([{ kind: 'text', text: l.replace(/^ +/, i => 'x'.repeat(i.length)) }], text)
  const body = s.diagram ? s.lines.length : s.lines.reduce((n, l) => n + wrapped(l), 0)
  return (s.gutter ? 1 : 0) + Math.max(1, body)
}

// tinted card sized to its code: dim language left and line count right in
// the header row, glass's own highlighter below, a gutter once long. A
// diagram draws as typed: no header or gutter, rows cut at the card edge,
// since a wrapped row breaks every box and arrow below it
function renderFence(c: Ctx, lang: string, source: string): RenderElement {
  const { t, p } = c
  const { code, lines: codeLines, diagram, gutter, digits, width } = fenceShape(lang, source, c.m)
  const lines = codeLines.length
  const children: RenderElement[] = []
  // a short fence has no header row: the highlighter colors by the
  // language and the code says what it is (proposal 14, 2026-10-04)
  if (gutter) {
    children.push(
      t.Box({
        flexDirection: 'row',
        children: [
          t.Text({ color: p.faint, children: [lang ? lang.toUpperCase() : ''] }),
          t.Box({ flexGrow: 1, children: [] }),
          t.Text({ color: p.faint, children: [`${lines} lines`] }),
        ],
      }),
    )
  }
  // the body is glass's own highlighter (hooks/highlight.ts), one row per
  // line, the gutter in `faint` once over 8 lines: the engine's `Code`
  // paints with a theme the owner rejected (2026-10-03)
  highlight(code, lang.toLowerCase()).forEach((spans, i) => {
    // a blank line is one space, so its row is drawn: a Text with no text
    // may measure no rows at all, and the card would lose its blank lines
    const body = t.Text({
      wrap: diagram ? 'truncate-end' : 'wrap',
      children: spans.length === 0 ? [' '] : spans.flatMap((s): RenderNode[] => (s.kind === 'plain' ? cut(s.text) : [t.Text({ color: codeColor(p, s.kind), children: cut(s.text) })])),
    })
    children.push(
      gutter
        ? t.Box({
            flexDirection: 'row',
            children: [
              t.Text({ color: p.faint, children: [String(i + 1).padStart(digits) + '  '] }),
              t.Box({ flexGrow: 1, flexShrink: 1, children: [body] }),
            ],
          })
        : body,
    )
  })
  return t.Box({
    flexDirection: 'column',
    width,
    backgroundColor: p.blockBg,
    paddingLeft: 1,
    paddingRight: 1,
    children,
  })
}


// where each item sits: a child hangs off its parent's text column, so
// under `1. Install` the ring lands under the `I`, as CommonMark renderers
// and Claude Desktop draw it (`depth * 2` put it under the period); ordered
// markers pad to the widest at their own depth
type ListLayout = { indent: number[]; numWidth: number[] }
function listLayout(items: ListItem[]): ListLayout {
  const numWidth: number[] = []
  for (const it of items) {
    if (/^\d/.test(it.marker) && !it.task) numWidth[it.depth] = Math.max(numWidth[it.depth] ?? 0, cellWidth(it.marker))
  }
  const cols: number[] = []
  const marks: number[] = []
  const indent = items.map(it => {
    const d = it.depth
    const col = d === 0 ? 0 : (cols[d - 1] ?? 0) + (marks[d - 1] ?? 2)
    cols[d] = col
    marks[d] = itemMarker(it, numWidth[d] ?? 0)
    return col
  })
  return { indent, numWidth: Array.from(numWidth, n => n ?? 0) }
}

function renderList(c: Ctx, items: ListItem[]): RenderElement {
  const { t, p, m } = c
  const { indent, numWidth } = listLayout(items)
  const marker = (it: ListItem): RenderElement => {
    // a done task is the one list mark that gets a color, as in tidepool
    if (it.task === 'done') return t.Text({ color: p.ok, children: [G.check + ' '] })
    if (it.task === 'todo') return t.Text({ color: p.bullet, children: [G.box + ' '] })
    // numbers right-aligned, so `9.` and `10.` end on one column
    if (/^\d/.test(it.marker)) return t.Text({ color: p.orderedNum, children: [it.marker.padStart(numWidth[it.depth] ?? 0) + ' '] })
    return t.Text({ color: p.bullet, children: [(it.depth > 0 ? G.ring : G.dot) + ' '] })
  }
  const row = (it: ListItem, i: number, air: boolean) =>
    t.Box({
      flexDirection: 'row',
      // nested items end at the measure like everything else
      width: Math.max(10, m - indent[i]!),
      marginLeft: indent[i],
      ...(air ? { marginTop: 1 } : {}),
      children: [
        marker(it),
        t.Box({
          flexGrow: 1,
          flexShrink: 1,
          children: [t.Text({ wrap: 'wrap', children: renderInlines(c, it.inlines) })],
        }),
      ],
    })
  return t.Box({
    flexDirection: 'column',
    children: items.map((it, i) => {
      // zero rows between items, except one each side of a card under an
      // item: text touching a tint read as a glitch
      const air = i > 0 && (items[i - 1]!.blocks?.length ?? 0) > 0
      if (!it.blocks?.length) return row(it, i, air)
      // a fence typed under the item sits under its text, at the text's
      // left edge, as wide as the item's text at most (0.4.22)
      const under = indent[i]! + itemMarker(it, numWidth[it.depth] ?? 0)
      const inner = { ...c, m: Math.max(10, m - under) }
      return t.Box({
        flexDirection: 'column',
        children: [row(it, i, air), ...it.blocks.map(b => t.Box({ marginLeft: under, marginTop: 1, children: [renderBlock(inner, b)] }))],
      })
    }),
  })
}

// cells an item's marker takes before its text
function itemMarker(it: ListItem, numWidth: number): number {
  return /^\d/.test(it.marker) && !it.task ? numWidth + 1 : 2
}

// A quote: a thin continuous bar down the left edge, one quarter-block
// glyph per row of the quote (the row count estimated from the same
// wrapping the engine applies), a space, then the inner blocks at `M - 2`
// with a blank row between them. No tint.
function renderQuote(c: Ctx, blocks: Block[]): RenderElement {
  const { t, p, m } = c
  // quoted prose keeps the prose color: a `meta` step was tried and the
  // owner wanted the color back (2026-10-11); `tone` stays for a block
  // that may want it later
  const inner = { ...c, m: m - 2 }
  const height = quoteRows(blocks, m)
  return t.Box({
    flexDirection: 'row',
    children: [
      t.Box({ width: 2, flexShrink: 0, children: [t.Text({ color: p.quoteBar, children: [Array(height).fill(G.mark).join('\n')] })] }),
      t.Box({
        flexDirection: 'column',
        flexGrow: 1,
        flexShrink: 1,
        width: m - 2,
        rowGap: 1,
        children: blocks.map(b => renderBlock(inner, b)),
      }),
    ],
  })
}

// rows a quote takes at measure `m`: its blocks at `m - 2`, a blank between
export function quoteRows(blocks: Block[], m: number): number {
  const w = m - 2
  const rows = blocks.reduce((n, b) => n + blockRows(b, w), 0) + Math.max(0, blocks.length - 1)
  return Math.max(1, rows)
}

// rows a block takes at measure `m`, mirroring what renderBlock draws
function blockRows(b: Block, m: number): number {
  switch (b.kind) {
    case 'paragraph':
    case 'heading':
      return wrappedLines(b.inlines, m)
    case 'code':
      return fenceRows(fenceShape(b.lang, b.source, m))
    case 'list': {
      const { indent, numWidth } = listLayout(b.items)
      return b.items.reduce((n, it, i) => {
        const marker = itemMarker(it, numWidth[it.depth] ?? 0)
        const width = Math.max(10, m - indent[i]!) - marker
        const air = i > 0 && (b.items[i - 1]!.blocks?.length ?? 0) > 0 ? 1 : 0
        const under = (it.blocks ?? []).reduce((k, inner) => k + 1 + blockRows(inner, Math.max(10, m - indent[i]! - marker)), 0)
        return n + air + wrappedLines(it.inlines, width) + under
      }, 0)
    }
    case 'rule':
      return 1
    case 'raw':
      return wrappedLines([{ kind: 'text', text: b.text }], m)
    case 'quote':
      return quoteRows(b.blocks, m)
    case 'table':
      // a table too wide even squeezed is the engine's Markdown, estimated as raw is
      return tableColumns(b.header, b.rows, m) ? b.rows.length + 2 : wrappedLines([{ kind: 'text', text: b.raw }], m)
    case 'callout': {
      const lw = labelWidth(b.tone)
      const rowWidth = (r: CalloutRow) => 2 + lw + 2 + inlineWidth(r.inlines) + 1
      const width = cardWidth(m, Math.max(0, ...b.rows.map(rowWidth)))
      const textWidth = width - 2 - lw - 2 - 1
      return 1 + Math.max(1, b.rows.reduce((n, r) => n + wrappedLines(r.inlines, textWidth), 0))
    }
  }
}

// each column's width: its widest cell, header included
function tableWidths(header: Inline[][], rows: Inline[][][]): number[] {
  return Array.from({ length: header.length }, (_, col) =>
    Math.max(1, inlineWidth(header[col] ?? []), ...rows.map(r => inlineWidth(r[col] ?? []))),
  )
}

// the column widths glass draws the table with at measure `m`, two cells
// kept free: too wide, the widest column gives up a cell at a time down to
// COL_MIN; null when even that does not fit. The quote bar asks the same
// question renderTable does.
function tableColumns(header: Inline[][], rows: Inline[][][], m: number): number[] | null {
  const widths = tableWidths(header, rows)
  const room = m - 2 - 2 * (header.length - 1)
  let over = widths.reduce((a, w) => a + w, 0) - room
  while (over > 0) {
    const widest = widths.indexOf(Math.max(...widths))
    if ((widths[widest] ?? 0) <= COL_MIN) return null
    widths[widest]!--
    over--
  }
  return widths
}

// a cell past its column's width: its text cut in the middle (styling goes,
// the cell being plain text from there)
function squeeze(inlines: Inline[], w: number): Inline[] {
  return inlineWidth(inlines) <= w ? inlines : [{ kind: 'text', text: clipMiddle(inlineText(inlines), w) }]
}

// row-separator table: bold header, one rule, two-cell gaps, no verticals;
// numeric columns right-align unless the markdown says otherwise; a table
// wider than the measure squeezes its widest columns, cells cut in the
// middle, and falls back to the engine's renderer only when that is not
// enough (a table three cells too wide jumped to the engine's boxes)
function renderTable(c: Ctx, header: Inline[][], align: (Align | null)[], rows: Inline[][][], raw: string): RenderElement {
  const { t, p } = c
  const cols = header.length
  const widths = tableColumns(header, rows, c.m)
  if (!widths) return t.Markdown({ text: raw.slice(0, MAX_TEXT) })
  header = header.map((h, i) => squeeze(h, widths[i] ?? COL_MIN))
  rows = rows.map(r => r.map((cell, i) => squeeze(cell, widths[i] ?? COL_MIN)))
  // `42`, `-3`, `1.5k`, `$12`, `80%`, `12ms`; an empty or placeholder cell does not decide
  const numeric = (col: number) => {
    const cells = rows.map(r => inlineText(r[col] ?? []).trim()).filter(x => x !== '' && !PLACEHOLDER_RE.test(x))
    return cells.length > 0 && cells.every(x => NUMERIC_RE.test(x))
  }
  const cell = (inlines: Inline[], col: number, isHeader: boolean): RenderElement => {
    const pad = Math.max(0, (widths[col] ?? 0) - inlineWidth(inlines))
    const a: Align = align[col] ?? (numeric(col) ? 'right' : 'left')
    // the header sits where its column's cells do, so `Count` ends over its numbers
    const last = col === cols - 1
    // the last column never pads to its right, nor to its left when empty
    const left = last && inlineWidth(inlines) === 0 ? 0 : a === 'right' ? pad : a === 'center' ? Math.floor(pad / 2) : 0
    const right = last ? 0 : pad - left
    return t.Text({
      ...(isHeader ? { bold: true, color: p.bold } : {}),
      children: [' '.repeat(left), ...renderInlines(c, inlines), ' '.repeat(right) + (last ? '' : '  ')],
    })
  }
  const line = (cells: Inline[][], isHeader: boolean) =>
    t.Box({
      flexDirection: 'row',
      children: Array.from({ length: cols }, (_, col) => cell(cells[col] ?? [], col, isHeader)),
    })
  return t.Box({
    flexDirection: 'column',
    children: [
      line(header, true),
      t.Text({ color: p.rule, children: [widths.map(w => G.rule.repeat(w)).join('  ')] }),
      ...rows.map(r => line(r, false)),
    ],
  })
}

// lines a run of inlines takes when wrapped at `width`, the way the engine
// wraps: at spaces, a word wider than the line broken across lines
function wrappedLines(inlines: Inline[], width: number): number {
  if (width < 1) return 1
  let lines = 0
  for (const raw of inlineText(inlines).split('\n')) {
    lines++
    let col = 0
    for (const word of raw.split(' ')) {
      const w = cellWidth(word)
      if (w === 0 && col === 0) continue
      const need = col === 0 ? w : col + 1 + w
      if (need <= width) {
        col = need
      } else if (w > width) {
        // a word wider than the line starts on a fresh line and is chopped
        if (col > 0) lines++
        lines += Math.ceil(w / width) - 1
        col = w % width || width
      } else {
        lines++
        col = w
      }
    }
  }
  return lines
}

// The Bottom line card. The title sits above the card as a plain bold line;
// only the labelled rows live inside, sized to the longest row. A thin
// continuous bar down the left edge: a quarter-block glyph on every row of
// the card, the row count computed from the same wrapping the engine
// applies. Compact: no padding and no blank rows; the colored label column
// keeps the rows apart.
// tone 'tip' (0.18.0) is the prompt tip: same card, the palette's `mark`
// gold for the title, bar and labels so it never reads as a Bottom line,
// and the Try row (the rewritten prompt) italic in `ok`: the better
// version. `accentUser` was 0.18.0; prism's is coral, beside its error red.
function renderCallout(c: Ctx, title: string, rows: CalloutRow[], tone?: 'tip'): RenderElement {
  const { t, p } = c
  const tip = tone === 'tip'
  const lw = labelWidth(tone)
  const bar = tip ? p.mark : p.calloutBar
  const rowWidth = (r: CalloutRow) => 2 + lw + 2 + inlineWidth(r.inlines) + 1
  const width = cardWidth(c.m, Math.max(0, ...rows.map(rowWidth)))
  const textWidth = width - 2 - lw - 2 - 1
  const lines = rows.map(r => wrappedLines(r.inlines, textWidth))
  // each row's wrapped lines; the title is outside the card
  const height = Math.max(1, lines.reduce((n, l) => n + l, 0))
  const labelColor = (r: CalloutRow) => (tip ? (r.label === 'Try' ? p.ok : p.mark) : p[LABEL_COLOR[r.label] ?? 'calloutText'])
  const rowText = (r: CalloutRow) =>
    tip && r.label === 'Try'
      ? t.Text({ color: p.ok, italic: true, wrap: 'wrap', children: renderInlines({ ...c, tone: p.ok }, r.inlines) })
      : t.Text({ color: p.calloutText, wrap: 'wrap', children: renderInlines(c, r.inlines) })
  const card = t.Box({
    flexDirection: 'row',
    width,
    backgroundColor: p.blockBg,
    children: [
      t.Box({ width: 1, children: [t.Text({ color: bar, children: [Array(height).fill(G.mark).join('\n')] })] }),
      t.Box({
        flexDirection: 'column',
        flexGrow: 1,
        flexShrink: 1,
        paddingLeft: 1,
        children: rows.map(r =>
          t.Box({
            flexDirection: 'row',
            children: [
              // a fixed-width box, so a long row never squeezes the label column
              t.Box({
                width: lw + 2,
                flexShrink: 0,
                children: [t.Text({ bold: true, color: labelColor(r), children: [r.label.padEnd(lw) + '  '] })],
              }),
              t.Box({
                flexGrow: 1,
                flexShrink: 1,
                paddingRight: 1,
                children: [rowText(r)],
              }),
            ],
          }),
        ),
      }),
    ],
  })
  return t.Box({
    flexDirection: 'column',
    children: [t.Text({ bold: true, color: bar, children: [tip ? G.pencil + ' ' + title : title] }), card],
  })
}

function renderInlines(c: Ctx, inlines: Inline[]): RenderNode[] {
  const { t, p } = c
  return inlines.flatMap((n): RenderNode[] => {
    switch (n.kind) {
      case 'text':
        return c.tone ? [t.Text({ color: c.tone, children: renderProse(c, n.text) })] : renderProse(c, n.text)
      case 'bold':
        // bold keeps its own color inside a muted block
        return [t.Text({ bold: true, color: p.bold, children: renderInlines({ ...c, tone: undefined }, n.children) })]
      case 'italic':
        return [t.Text({ italic: true, children: renderInlines(c, n.children) })]
      case 'strike':
        return [t.Text({ strikethrough: true, children: renderInlines(c, n.children) })]
      case 'link':
        return [renderLink(c, n.text, n.href)]
      case 'code':
        return [renderCode(c, n.text)]
    }
  })
}

// Prose outside backticks, painted: command
// spans once there is evidence (`git push --follow-tags`, never `make
// sure`), then paths and URLs anywhere (`README.md`, `~/.zshrc`,
// `src/main.rs:42` with its line number in the number color).
function renderProse(c: Ctx, text: string): RenderNode[] {
  const { t, p } = c
  const out: RenderNode[] = []
  const spans = proseSpans(text)
  let pos = 0
  const colored = (s: string, kind: SpanKind): RenderNode[] => (kind === 'plain' ? cut(s) : [t.Text({ color: p[kind], children: cut(s) })])
  for (const s of spans) {
    if (s.start > pos) out.push(...renderWords(c, text.slice(pos, s.start)))
    out.push(...colored(text.slice(s.start, s.end), s.kind))
    pos = s.end
  }
  if (pos < text.length) out.push(...renderWords(c, text.slice(pos)))
  return out
}

// paths and URLs in a run of plain prose
function renderWords(c: Ctx, text: string): RenderNode[] {
  if (!/[/.@]/.test(text)) return cut(text)
  const { t, p } = c
  const out: RenderNode[] = []
  let buf = ''
  const flush = () => {
    if (buf) out.push(...cut(buf))
    buf = ''
  }
  for (const part of text.split(/(\s+)/)) {
    const { lead, word, tail } = bareWord(part)
    if (!word) {
      buf += part
      continue
    }
    if (isUrl(word)) {
      buf += lead
      flush()
      out.push(t.Text({ color: p.url, underline: true, children: cut(word) }))
      buf += tail
      continue
    }
    const path = pathLike(word)
    if (path) {
      buf += lead
      flush()
      out.push(t.Text({ color: p.path, children: cut(path.path) }))
      if (path.lineno) out.push(t.Text({ color: p.num, children: [path.lineno] }))
      buf += tail
      continue
    }
    buf += part
  }
  flush()
  return out
}

function renderLink(c: Ctx, label: string, href: string): RenderElement {
  const { t, p } = c
  const styled = t.Text({ color: p.url, underline: true, children: cut(label) })
  const safe = safeHref(href)
  return safe ? t.Link({ href: safe, children: [styled] }) : styled
}

// the Link element refuses the whole tree on a bad href, so be strict
function safeHref(href: string): string | null {
  try {
    const u = new URL(href)
    const ok = u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === 'localhost')
    if (!ok || u.username || u.password || u.href.length > 2048) return null
    if (!/^[\x21-\x7e]+$/.test(u.href)) return null
    return u.href
  } catch {
    return null
  }
}

// Inline code is color only, as Claude Desktop and the Codex TUI draw it:
// shell tokens in their kind colors, paths in the path color underlined,
// anything else in the code color. No tint, no padding. A span that is a
// URL whole is a link like any other, so a wrapped one stays one click
// (0.15.3: the engine's own renderer does this since 2.1.302).
function renderCode(c: Ctx, code: string): RenderElement {
  const { t, p } = c
  if (!/\s/.test(code) && safeHref(code)) return renderLink(c, code, code)
  const spans = shellSpans(code)
  if (spans) {
    return t.Text({
      children: spans.flatMap((s): RenderNode[] => (s.kind === 'plain' ? cut(s.text) : [t.Text({ color: p[s.kind], children: cut(s.text) })])),
    })
  }
  if (PATH_RE.test(code)) return t.Text({ color: p.path, children: cut(code) })
  return t.Text({ color: p.code, children: cut(code) })
}
