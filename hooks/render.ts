// Draws a parsed reply as an element tree, following SPEC.md: full-width
// prose, one rhythm rule, color-only inline code, two content-fit tinted
// cards, one glyph family (see glyphs.ts), one width ruler (see width.ts).
import type { Elements, RenderElement, RenderNode } from 'claude-code'

import { G } from './glyphs'
import { CODE_COLOR, highlight } from './highlight'
import { inlineText } from './markdown'
import type { Align, Block, CalloutRow, Inline, ListItem } from './markdown'
import type { Palette } from './palette'
import { bareWord, isUrl, pathLike } from './paths'
import { isPrivateNote, needsAttention } from './prose'
import { proseSpans, shellSpans } from './shell'
import type { SpanKind } from './shell'
import { cellWidth } from './width'

type Table = Elements['terminal']

type Ctx = {
  t: Table
  p: Palette
  /** the prose measure in cells */
  m: number
  /** the terminal's width */
  columns: number
}

export type RenderOptions = {
  /** draw the bullet that opens a reply */
  bullet: boolean
  /** the first text block of a reply: keeps a blank row above, bullet or not */
  first?: boolean
  columns: number
  /** gutter marks beside paragraphs that need the reader; off when the prompt asked for writing */
  marks: boolean
}

const LABEL_WIDTH = 8
const LABEL_COLOR: Record<string, keyof Palette> = {
  Verified: 'verified',
  Issue: 'issue',
  Fix: 'fix',
}

// the API bounds a Text or Code string at this many characters
const MAX_TEXT = 10000
// a tinted card never gets narrower than this
const CARD_MIN = 60

// inside backticks a path needs a slash or a `:line` suffix:
// `hooks/render.ts:88`, `src/main.rs`, `~/.zshrc`; not `shell.ts`
const PATH_RE = /^(?:~|\.{1,2})?[\w.-]*(?:\/[\w.-]+)+\/?(?::\d+(?::\d+)?)?$|^[\w.-]+\.\w+:\d+(?::\d+)?$/

export function measure(columns: number): number {
  return Math.max(20, columns - 2)
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
function cardWidth(c: Ctx, content: number): number {
  return Math.min(c.m, Math.max(CARD_MIN, content))
}

export function renderReply(t: Table, blocks: Block[], p: Palette, o: RenderOptions): RenderElement {
  const c: Ctx = { t, p, m: measure(o.columns), columns: o.columns }
  const rows: RenderElement[] = []
  let prev: Block['kind'] | null = null
  blocks.forEach((b, i) => {
    const el = renderBlock(c, b)
    if (i === 0 && o.bullet) {
      // the engine's own message row keeps a blank above the bullet; without
      // it the reply sits glued to the tool output before it
      rows.push(
        t.Box({
          flexDirection: 'row',
          marginTop: 1,
          children: [
            t.Text({ color: p.accent, children: [G.bullet + ' '] }),
            t.Box({ flexDirection: 'column', flexGrow: 1, flexShrink: 1, children: [el] }),
          ],
        }),
      )
    } else {
      // one rhythm rule: a blank above every block except the first and any
      // block right under a heading; the reply's first block keeps the blank
      // the bullet row had, so it never sits glued to the tool rows above
      const marginTop = i === 0 ? (o.first ? 1 : 0) : prev === 'heading' ? 0 : 1
      // a paragraph that asks something of the reader gets a gutter mark in
      // the two cells every other block leaves blank
      const marked = o.marks && b.kind === 'paragraph' && !isPrivateNote(inlineText(b.inlines)) && needsAttention(inlineText(b.inlines))
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
    }
    prev = b.kind
  })
  return t.Box({ flexDirection: 'column', children: rows })
}

function renderBlock(c: Ctx, b: Block): RenderElement {
  const { t, p, m } = c
  switch (b.kind) {
    case 'paragraph': {
      // Claude's own planning note, drawn italic in a quiet color so the
      // real answer stands out
      if (isPrivateNote(inlineText(b.inlines))) {
        return t.Box({ width: m, children: [t.Text({ wrap: 'wrap', italic: true, color: p.private, children: [inlineText(b.inlines)] })] })
      }
      return t.Box({ width: m, children: [t.Text({ wrap: 'wrap', children: renderInlines(c, b.inlines) })] })
    }
    case 'heading':
      return t.Text({
        bold: true,
        color: b.level >= 3 ? p.heading3 : p.heading,
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
      return renderCallout(c, b.title, b.rows)
  }
}

// a fence with no language (or a plain-text one) whose rows are mostly
// arrows, box-drawing, block or shape glyphs is a picture, not code
const DIAGRAM_LANGS = new Set(['', 'text', 'txt', 'ascii', 'diagram'])

function isDrawingGlyph(code: number): boolean {
  return (code >= 0x2190 && code <= 0x21ff) || (code >= 0x2500 && code <= 0x25ff)
}

function isDiagram(lang: string, source: string): boolean {
  if (!DIAGRAM_LANGS.has(lang.toLowerCase())) return false
  const rows = source.split('\n').filter(l => l.trim() !== '')
  const drawn = rows.filter(l => [...l].some(ch => isDrawingGlyph(ch.codePointAt(0)!))).length
  return rows.length > 0 && drawn * 2 >= rows.length
}

// tinted card sized to its code: dim language left and line count right in
// the header row, glass's own highlighter below, a gutter once long. A
// diagram draws as typed: no header or gutter, rows cut at the card edge,
// since a wrapped row breaks every box and arrow below it
function renderFence(c: Ctx, lang: string, source: string): RenderElement {
  const { t, p } = c
  const code = source.replace(/\n$/, '')
  const codeLines = code === '' ? [] : code.split('\n')
  const lines = codeLines.length
  const diagram = isDiagram(lang, code)
  const gutter = !diagram && lines > 8
  const digits = String(lines).length
  const widest = Math.max(0, ...codeLines.map(cellWidth))
  const header = cellWidth(lang) + (gutter ? cellWidth(`${lines} lines`) + 2 : 0)
  const width = cardWidth(c, Math.max(widest + (gutter ? digits + 2 : 0), header) + 2)
  const children: RenderElement[] = []
  // a short fence has no header row: the highlighter colors by the
  // language and the code says what it is (proposal 14, 2026-10-04)
  if (gutter) {
    children.push(
      t.Box({
        flexDirection: 'row',
        children: [
          t.Text({ dimColor: true, children: [lang ? lang.toUpperCase() : ''] }),
          t.Box({ flexGrow: 1, children: [] }),
          ...(gutter ? [t.Text({ dimColor: true, children: [`${lines} lines`] })] : []),
        ],
      }),
    )
  }
  // the body is glass's own highlighter (hooks/highlight.ts), one row per
  // line, the gutter in `faint` once over 8 lines: the engine's `Code`
  // paints with a theme the owner rejected (2026-10-03)
  highlight(code, lang.toLowerCase()).forEach((spans, i) => {
    const body = t.Text({
      wrap: diagram ? 'truncate-end' : 'wrap',
      children: spans.map(s => (s.kind === 'plain' ? s.text : t.Text({ color: p[CODE_COLOR[s.kind]], children: [s.text] }))),
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


function renderList(c: Ctx, items: ListItem[]): RenderElement {
  const { t, p, m } = c
  const ordered = items.filter(it => /^\d/.test(it.marker))
  const numWidth = Math.max(0, ...ordered.map(it => cellWidth(it.marker)))
  const marker = (it: ListItem): RenderElement => {
    // a done task is the one list mark that gets a color, as in tidepool
    if (it.task === 'done') return t.Text({ color: p.ok, children: [G.check + ' '] })
    if (it.task === 'todo') return t.Text({ color: p.bullet, children: [G.box + ' '] })
    if (/^\d/.test(it.marker)) return t.Text({ color: p.orderedNum, children: [it.marker.padEnd(numWidth) + ' '] })
    return t.Text({ color: p.bullet, children: [(it.depth > 0 ? G.ring : G.dot) + ' '] })
  }
  return t.Box({
    flexDirection: 'column',
    children: items.map(it =>
      t.Box({
        flexDirection: 'row',
        // nested items end at the measure like everything else
        width: Math.max(10, m - it.depth * 2),
        marginLeft: it.depth * 2,
        children: [
          marker(it),
          t.Box({
            flexGrow: 1,
            flexShrink: 1,
            children: [t.Text({ wrap: 'wrap', children: renderInlines(c, it.inlines) })],
          }),
        ],
      }),
    ),
  })
}

// A quote: a thin continuous bar down the left edge, one quarter-block
// glyph per row of the quote (the row count estimated from the same
// wrapping the engine applies), a space, then the inner blocks at `M - 2`
// with a blank row between them. No tint.
function renderQuote(c: Ctx, blocks: Block[]): RenderElement {
  const { t, p, m } = c
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
    case 'code': {
      const code = b.source.replace(/\n$/, '')
      const lines = code === '' ? 0 : code.split('\n').length
      if (isDiagram(b.lang, code)) return Math.max(1, lines)
      return (lines > 8 ? 1 : 0) + Math.max(1, lines)
    }
    case 'list': {
      const ordered = b.items.filter(it => /^\d/.test(it.marker))
      const numWidth = Math.max(0, ...ordered.map(it => cellWidth(it.marker)))
      return b.items.reduce((n, it) => {
        const marker = /^\d/.test(it.marker) && !it.task ? numWidth + 1 : 2
        return n + wrappedLines(it.inlines, Math.max(10, m - it.depth * 2) - marker)
      }, 0)
    }
    case 'rule':
      return 1
    case 'raw':
      return wrappedLines([{ kind: 'text', text: b.text }], m)
    case 'quote':
      return quoteRows(b.blocks, m)
    case 'table':
      return b.rows.length + 2
    case 'callout': {
      const rowWidth = (r: CalloutRow) => 2 + LABEL_WIDTH + 2 + inlineWidth(r.inlines) + 1
      const width = Math.max(CARD_MIN, Math.min(m, Math.max(0, ...b.rows.map(rowWidth))))
      const textWidth = width - 2 - LABEL_WIDTH - 2 - 1
      return 1 + Math.max(1, b.rows.reduce((n, r) => n + wrappedLines(r.inlines, textWidth), 0))
    }
  }
}

// row-separator table: bold header, one rule, two-cell gaps, no verticals;
// numeric columns right-align unless the markdown says otherwise; a table
// wider than the terminal falls back to the engine's renderer
function renderTable(c: Ctx, header: Inline[][], align: Align[], rows: Inline[][][], raw: string): RenderElement {
  const { t, p } = c
  const cols = header.length
  const widths = Array.from({ length: cols }, (_, col) =>
    Math.max(1, inlineWidth(header[col] ?? []), ...rows.map(r => inlineWidth(r[col] ?? []))),
  )
  const total = widths.reduce((a, w) => a + w, 0) + 2 * (cols - 1)
  if (total > c.columns - 4) return t.Markdown({ text: raw.slice(0, MAX_TEXT) })
  const numeric = (col: number) =>
    rows.length > 0 && rows.every(r => /^[\d.,]+%?$/.test(inlineText(r[col] ?? [])))
  const cell = (inlines: Inline[], col: number, isHeader: boolean): RenderElement => {
    const pad = Math.max(0, (widths[col] ?? 0) - inlineWidth(inlines))
    const a: Align = align[col] ?? (numeric(col) ? 'right' : 'left')
    const left = isHeader ? 0 : a === 'right' ? pad : a === 'center' ? Math.floor(pad / 2) : 0
    const last = col === cols - 1
    const right = last && left === 0 ? 0 : pad - left
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
function renderCallout(c: Ctx, title: string, rows: CalloutRow[]): RenderElement {
  const { t, p } = c
  const rowWidth = (r: CalloutRow) => 2 + LABEL_WIDTH + 2 + inlineWidth(r.inlines) + 1
  const width = cardWidth(c, Math.max(0, ...rows.map(rowWidth)))
  const textWidth = width - 2 - LABEL_WIDTH - 2 - 1
  const lines = rows.map(r => wrappedLines(r.inlines, textWidth))
  // each row's wrapped lines; the title is outside the card
  const height = Math.max(1, lines.reduce((n, l) => n + l, 0))
  const card = t.Box({
    flexDirection: 'row',
    width,
    backgroundColor: p.blockBg,
    children: [
      t.Box({ width: 1, children: [t.Text({ color: p.calloutBar, children: [Array(height).fill(G.mark).join('\n')] })] }),
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
                width: LABEL_WIDTH + 2,
                flexShrink: 0,
                children: [t.Text({ bold: true, color: p[LABEL_COLOR[r.label] ?? 'calloutText'], children: [r.label.padEnd(LABEL_WIDTH) + '  '] })],
              }),
              t.Box({
                flexGrow: 1,
                flexShrink: 1,
                paddingRight: 1,
                children: [t.Text({ color: p.calloutText, wrap: 'wrap', children: renderInlines(c, r.inlines) })],
              }),
            ],
          }),
        ),
      }),
    ],
  })
  return t.Box({
    flexDirection: 'column',
    children: [t.Text({ bold: true, color: p.calloutBar, children: [title] }), card],
  })
}

function renderInlines(c: Ctx, inlines: Inline[]): RenderNode[] {
  const { t, p } = c
  return inlines.flatMap((n): RenderNode[] => {
    switch (n.kind) {
      case 'text':
        return renderProse(c, n.text)
      case 'bold':
        return [t.Text({ bold: true, color: p.bold, children: renderInlines(c, n.children) })]
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

// Prose outside backticks, painted the way claude-hl painted it: command
// spans once there is evidence (`git push --follow-tags`, never `make
// sure`), then paths and URLs anywhere (`README.md`, `~/.zshrc`,
// `src/main.rs:42` with its line number in the number color).
function renderProse(c: Ctx, text: string): RenderNode[] {
  const { t, p } = c
  const out: RenderNode[] = []
  const spans = proseSpans(text)
  let pos = 0
  const colored = (s: string, kind: SpanKind): RenderNode => (kind === 'plain' ? s : t.Text({ color: p[kind], children: [s] }))
  for (const s of spans) {
    if (s.start > pos) out.push(...renderWords(c, text.slice(pos, s.start)))
    out.push(colored(text.slice(s.start, s.end), s.kind))
    pos = s.end
  }
  if (pos < text.length) out.push(...renderWords(c, text.slice(pos)))
  return out
}

// paths and URLs in a run of plain prose
function renderWords(c: Ctx, text: string): RenderNode[] {
  if (!/[/.@]/.test(text)) return [text]
  const { t, p } = c
  const out: RenderNode[] = []
  let buf = ''
  const flush = () => {
    if (buf) out.push(buf)
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
      out.push(t.Text({ color: p.url, underline: true, children: [word] }))
      buf += tail
      continue
    }
    const path = pathLike(word)
    if (path) {
      buf += lead
      flush()
      out.push(t.Text({ color: p.path, children: [path.path] }))
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
  const styled = t.Text({ color: p.url, underline: true, children: [label] })
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
// anything else in the code color. No tint, no padding.
function renderCode(c: Ctx, code: string): RenderElement {
  const { t, p } = c
  const spans = shellSpans(code)
  if (spans) {
    return t.Text({
      children: spans.map(s => (s.kind === 'plain' ? s.text : t.Text({ color: p[s.kind], children: [s.text] }))),
    })
  }
  if (PATH_RE.test(code)) return t.Text({ color: p.path, children: [code] })
  return t.Text({ color: p.code, children: [code] })
}
