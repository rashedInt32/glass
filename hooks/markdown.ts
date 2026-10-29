// A small markdown reader for assistant replies. It covers what the mod
// draws itself: paragraphs, headings, lists, fences, rules, tables, quotes
// and the Bottom line callout (plus the prompt tip card). Raw html is kept for the engine's own
// Markdown element. Streaming-safe: unclosed markup stays literal, and a
// callout, once its head line is seen, stays a callout as rows arrive.

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold' | 'italic' | 'strike'; children: Inline[] }
  | { kind: 'link'; text: string; href: string }

// `blocks`: fences indented under the item, drawn under its text (0.4.22)
export type ListItem = { depth: number; marker: string; task?: 'todo' | 'done'; inlines: Inline[]; blocks?: Block[] }
export type CalloutRow = { label: string; inlines: Inline[] }
export type Align = 'left' | 'center' | 'right'

export type Block =
  | { kind: 'paragraph'; inlines: Inline[] }
  | { kind: 'heading'; level: number; inlines: Inline[] }
  | { kind: 'code'; lang: string; source: string }
  | { kind: 'list'; items: ListItem[] }
  | { kind: 'rule' }
  | { kind: 'raw'; text: string }
  | { kind: 'quote'; blocks: Block[] }
  // align: null where the separator names none (`---`), so a numeric column can right-align
  | { kind: 'table'; header: Inline[][]; align: (Align | null)[]; rows: Inline[][][]; raw: string }
  // tone 'tip': the prompt tip card (0.18.0), Why / Try rows in the mark color
  | { kind: 'callout'; title: string; rows: CalloutRow[]; tone?: 'tip' }

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const TASK_RE = /^\[([ xX])\]\s+(.*)$/
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE_RE = /^\s*([-*_])(\s*\1){2,}\s*$/
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
// the info string may carry attributes after the language: ```ts title=x
const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/
// a fence indented under a list item, any depth
const ITEM_FENCE_RE = /^(\s+)(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/
const QUOTE_RE = /^\s*>\s?(.*)$/
const RAW_START_RE = /^\s*<[a-zA-Z!/]/
// `**Bottom line**`, `**Bottom line**:` and `**Bottom line:**`
const CALLOUT_HEAD_RE = /^\*\*(Bottom line):?\*\*:?\s*$/i
// a quote opening `**<glyph> Prompt tip:** reason`; the glyph is optional and
// any one symbol, so this file stays ASCII
const TIP_HEAD_RE = /^\*\*(?:\S+\s+)?(Prompt tip):?\*\*:?\s*(.*)$/i
const CALLOUT_ROW_RE = /^(?:[-*+]\s+)?\*{0,2}(Verified|Issue|Fix)\s*:?\*{0,2}\s*:?\s+(.*)$/

// U+FE0F after a symbol that is not an emoji by default (U+26A0 and kin)
const TEXT_SYMBOL_VS16 = new RegExp('(\\P{Emoji_Presentation})' + String.fromCodePoint(0xfe0f), 'gu')

export function parseMarkdown(input: string): Block[] {
  // the API allows only tab and newline as control characters in a Text;
  // anything else would get the whole tree refused
  const text = input
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    // a variation selector that turns a text-default symbol into an emoji
    // makes the terminal draw it 2 cells while the engine counts 1, and the
    // next character is drawn over: keep the symbol, drop the selector
    .replace(TEXT_SYMBOL_VS16, '$1')
  const lines = text.split('\n')
  const blocks: Block[] = []
  let i = 0
  // a header line followed by a separator with the same cell count
  const isTableStart = (idx: number) => {
    const l = lines[idx]
    const sep = lines[idx + 1]
    return l !== undefined && sep !== undefined && l.includes('|') && TABLE_SEP_RE.test(sep) && splitRow(sep).length === splitRow(l).length
  }
  const startsBlock = (idx: number) => {
    const l = lines[idx]!
    return (
      FENCE_RE.test(l) || HEADING_RE.test(l) || LIST_RE.test(l) || RULE_RE.test(l) || QUOTE_RE.test(l) || RAW_START_RE.test(l) || isTableStart(idx)
    )
  }

  while (i < lines.length) {
    const line = lines[i]!
    if (line.trim() === '') {
      i++
      continue
    }
    const fence = FENCE_RE.exec(line)
    if (fence) {
      const marks = fence[2]!
      const close = new RegExp(`^\\s{0,3}\\${marks[0]}{${marks.length},}\\s*$`)
      const body: string[] = []
      i++
      while (i < lines.length && !close.test(lines[i]!)) body.push(lines[i++]!)
      i++
      blocks.push({ kind: 'code', lang: fence[3] ?? '', source: body.join('\n') })
      continue
    }
    const heading = HEADING_RE.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, inlines: parseInline(heading[2]!) })
      i++
      continue
    }
    if (RULE_RE.test(line)) {
      blocks.push({ kind: 'rule' })
      i++
      continue
    }
    if (isTableStart(i)) {
      const start = i
      const header = splitRow(line)
      const align = splitRow(lines[i + 1]!).map(alignOf)
      i += 2
      const rows: Inline[][][] = []
      while (i < lines.length && lines[i]!.trim() !== '' && lines[i]!.includes('|')) {
        rows.push(splitRow(lines[i++]!).map(parseInline))
      }
      blocks.push({ kind: 'table', header: header.map(parseInline), align, rows, raw: lines.slice(start, i).join('\n') })
      continue
    }
    if (QUOTE_RE.test(line)) {
      const inner: string[] = []
      while (i < lines.length && lines[i]!.trim() !== '') inner.push(lines[i++]!.replace(QUOTE_RE, '$1'))
      blocks.push(tipBlock(inner) ?? { kind: 'quote', blocks: parseMarkdown(inner.join('\n')) })
      continue
    }
    if (RAW_START_RE.test(line)) {
      const raw: string[] = []
      while (i < lines.length && lines[i]!.trim() !== '') raw.push(lines[i++]!)
      blocks.push({ kind: 'raw', text: raw.join('\n') })
      continue
    }
    if (LIST_RE.test(line)) {
      const items: { depth: number; marker: string; text: string; blocks: Block[] }[] = []
      // nesting is the rank of an item's indent among the indents seen so
      // far, not floor(spaces / 2): `1. a` then `   - b` (three spaces, the
      // width of `1. `) is one level down, as CommonMark reads it
      const indents: number[] = []
      while (i < lines.length) {
        const l = lines[i]!
        if (l.trim() === '') {
          // a blank inside an item's fence is the fence's; otherwise the
          // list goes on only into another item
          if (i + 1 < lines.length && (LIST_RE.test(lines[i + 1]!) || ITEM_FENCE_RE.test(lines[i + 1]!)) && items.length > 0) {
            i++
            continue
          }
          break
        }
        const m = LIST_RE.exec(l)
        const fence = items.length > 0 ? ITEM_FENCE_RE.exec(l) : null
        if (m) {
          const indent = m[1]!.replace(/\t/g, '    ').length
          while (indents.length > 0 && indent < indents[indents.length - 1]!) indents.pop()
          if (indents.length === 0 || indent > indents[indents.length - 1]!) indents.push(indent)
          items.push({ depth: indents.length - 1, marker: m[2]!, text: m[3]!, blocks: [] })
        } else if (fence) {
          // a fence typed under the item (`1. Run:` then an indented block):
          // its lines lose the item's indent and draw as a card under the
          // text, not as inline code with newlines in it (0.4.22)
          const indent = fence[1]!.length
          const marks = fence[2]!
          const close = new RegExp(`^\\s*\\${marks[0]}{${marks.length},}\\s*$`)
          const body: string[] = []
          i++
          while (i < lines.length && !close.test(lines[i]!)) {
            const row = lines[i++]!
            body.push(row.slice(Math.min(indent, row.length - row.trimStart().length)))
          }
          items[items.length - 1]!.blocks.push({ kind: 'code', lang: fence[3] ?? '', source: body.join('\n') })
        } else if (/^\s+\S/.test(l) && items.length > 0) {
          items[items.length - 1]!.text += '\n' + l.trim()
        } else {
          break
        }
        i++
      }
      blocks.push({
        kind: 'list',
        items: items.map(it => {
          const task = TASK_RE.exec(it.text)
          const blocks = it.blocks.length ? { blocks: it.blocks } : {}
          if (!task) return { depth: it.depth, marker: it.marker, inlines: parseInline(it.text), ...blocks }
          return {
            depth: it.depth,
            marker: it.marker,
            task: task[1] === ' ' ? 'todo' : 'done',
            inlines: parseInline(task[2]!),
            ...blocks,
          }
        }),
      })
      continue
    }
    const para: string[] = [line]
    i++
    while (i < lines.length && lines[i]!.trim() !== '' && !startsBlock(i)) para.push(lines[i++]!)
    blocks.push(paragraphBlock(para))
  }
  return mergeCallouts(blocks)
}

// `| a | b |` -> ['a', 'b']; a `\|` inside a cell stays a pipe
function splitRow(line: string): string[] {
  const cells = line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map(c => c.trim().replace(/\\\|/g, '|'))
  return cells
}

function alignOf(sep: string): Align | null {
  const left = sep.startsWith(':')
  const right = sep.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  return left ? 'left' : null
}

// a callout row: labelled once `Label:` has arrived, a blank label before
function calloutRow(line: string): CalloutRow {
  const m = CALLOUT_ROW_RE.exec(line)
  return m ? { label: m[1]!, inlines: parseInline(m[2]!) } : { label: '', inlines: parseInline(line) }
}

// Monotonic: once the head line reads **Bottom line**, the block is a card
// for the rest of the stream, whatever the rows look like so far
function paragraphBlock(lines: string[]): Block {
  const head = CALLOUT_HEAD_RE.exec(lines[0]!)
  if (head) return { kind: 'callout', title: head[1]!, rows: lines.slice(1).map(calloutRow) }
  return { kind: 'paragraph', inlines: parseInline(lines.join('\n')) }
}

// The prompt tip: a quote whose first line is the tip head. The reason is
// the Why row, every later line is the Try row (the rewritten prompt).
// Monotonic like the Bottom line: the head alone is already a card.
function tipBlock(inner: string[]): Block | null {
  const head = TIP_HEAD_RE.exec(inner[0]!.trim())
  if (!head) return null
  const body = [head[2]!, ...inner.slice(1)].map(l => l.trim()).filter(l => l !== '')
  const rows: CalloutRow[] = []
  if (body.length > 0) rows.push({ label: 'Why', inlines: parseInline(body[0]!) })
  if (body.length > 1) rows.push({ label: 'Try', inlines: parseInline(body.slice(1).join(' ')) })
  return { kind: 'callout', title: head[1]!, rows, tone: 'tip' }
}

// `**Bottom line**` as a title-only card followed by a list: the list items
// are its rows
function mergeCallouts(blocks: Block[]): Block[] {
  const out: Block[] = []
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!
    const next = blocks[i + 1]
    if (b.kind === 'callout' && b.tone !== 'tip' && b.rows.length === 0 && next?.kind === 'list') {
      out.push({ kind: 'callout', title: b.title, rows: next.items.map(it => calloutRow(inlineText(it.inlines))) })
      i++
      continue
    }
    out.push(b)
  }
  return out
}

export function inlineText(inlines: Inline[]): string {
  return inlines
    .map(n => (n.kind === 'text' || n.kind === 'code' || n.kind === 'link' ? n.text : inlineText(n.children)))
    .join('')
}

// sticky: matched at `lastIndex`, so a long run is never copied per bracket
const URL_RE = /https?:\/\/[^\s<>)]+/y
// `[label](href)` and `[label](href "title")`; the title is not drawn
const MD_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/y

export function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let buf = ''
  const flush = () => {
    if (buf) out.push({ kind: 'text', text: buf })
    buf = ''
  }
  const n = src.length
  let i = 0
  while (i < n) {
    const c = src[i]!
    if (c === '\\' && i + 1 < n && '`*_~[]\\'.includes(src[i + 1]!)) {
      buf += src[i + 1]
      i += 2
      continue
    }
    if (c === '`') {
      let run = 1
      while (src[i + run] === '`') run++
      const ticks = '`'.repeat(run)
      const close = src.indexOf(ticks, i + run)
      if (close >= 0) {
        flush()
        let code = src.slice(i + run, close)
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1)
        out.push({ kind: 'code', text: code })
        i = close + run
        continue
      }
    }
    if (src.startsWith('**', i) || src.startsWith('__', i) || src.startsWith('~~', i)) {
      const d = src.slice(i, i + 2)
      const close = findClose(src, i + 2, d)
      if (close >= 0) {
        flush()
        out.push({ kind: d === '~~' ? 'strike' : 'bold', children: parseInline(src.slice(i + 2, close)) })
        i = close + 2
        continue
      }
    }
    if ((c === '*' || c === '_') && i + 1 < n && !/\s/.test(src[i + 1]!) && (c === '*' || i === 0 || !/\w/.test(src[i - 1]!))) {
      const close = findClose(src, i + 1, c)
      if (close >= 0) {
        flush()
        out.push({ kind: 'italic', children: parseInline(src.slice(i + 1, close)) })
        i = close + 1
        continue
      }
    }
    // a link, or an image `![alt](src)`, which a terminal shows as the link
    // its alt text names (the bang drew as text before 0.4.22)
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const at = c === '!' ? i + 1 : i
      MD_LINK_RE.lastIndex = at
      const m = MD_LINK_RE.exec(src)
      if (m) {
        flush()
        out.push({ kind: 'link', text: m[1]!, href: m[2]! })
        i = at + m[0].length
        continue
      }
    }
    if (c === 'h') {
      URL_RE.lastIndex = i
      const m = URL_RE.exec(src)
      if (m) {
        // sentence punctuation after a bare URL belongs to the sentence
        const url = m[0].replace(/[.,;:!?]+$/, '')
        flush()
        out.push({ kind: 'link', text: url, href: url })
        i += url.length
        continue
      }
    }
    buf += c
    i++
  }
  flush()
  return out
}

// the closing delimiter: not preceded by a space, and for `_` not followed
// by a word character
function findClose(src: string, from: number, d: string): number {
  let j = src.indexOf(d, from)
  while (j >= 0) {
    // `**bold *nested***`: the bold closes on the last two of the three stars
    if (d === '**' && src[j + 2] === '*') j += 1
    const after = src[j + d.length]
    if (!/\s/.test(src[j - 1]!) && (d[0] !== '_' || after === undefined || !/\w/.test(after))) return j
    j = src.indexOf(d, j + 1)
  }
  return -1
}
