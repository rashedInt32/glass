// The terminal painter the demo scripts share: a render tree to rows of
// text with SGR colors, and those rows to HTML for a screenshot.
//
// Layout is an approximation of the engine's: column boxes stack, row boxes
// sit side by side, a `space-between` row pushes its last child to the right
// edge of the room it has (the terminal width less the margins and widths
// above it), a tinted Box paints its width. A theme slot named as a color
// (planMode, diffAdded) resolves through `slots`.
//
// The renderers build plain trees and import nothing at runtime from
// 'claude-code', so any version of hooks/ loads here as ordinary modules.

export type Node = string | { type: string; props: Record<string, unknown> & { children?: Node[] } }
export type Style = { fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean }

export const ESC = String.fromCodePoint(0x1b)

export type Painter = {
  rows: (node: Node, inherited?: Style, room?: number) => string[]
  rgb: (color: string, bg: boolean) => string
  open: (s: Style) => string
  visible: (s: string) => number
  RESET: string
}

/**
 * A painter for `columns` cells wide, `slots` the theme's named colors;
 * `plain` paints no colors at all (for a paste).
 */
export function makePainter(opts: { columns: number; slots: Record<string, string>; plain?: boolean; buttons?: 'bracket' | 'label' }): Painter {
  const { columns, slots } = opts
  const plain = opts.plain === true
  // a Button as `[label]` for a text dump, or its bare label as the terminal draws it
  const button = (label: string) => (opts.buttons === 'label' ? label : `[${label}]`)
  const RESET = plain ? '' : `${ESC}[0m`

  function rgb(color: string, bg: boolean): string {
    if (plain) return ''
    const hex = /^#[0-9a-f]{6}$/i.test(color) ? color : slots[color]
    if (!hex) return ''
    const n = parseInt(hex.slice(1), 16)
    return `${ESC}[${bg ? 48 : 38};2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`
  }

  function open(s: Style): string {
    if (plain) return ''
    let out = ''
    if (s.fg) out += rgb(s.fg, false)
    if (s.bg) out += rgb(s.bg, true)
    if (s.bold) out += `${ESC}[1m`
    if (s.dim) out += `${ESC}[2m`
    if (s.italic) out += `${ESC}[3m`
    if (s.underline) out += `${ESC}[4m`
    return out
  }

  // one Text's inline content, styles nested
  function inline(node: Node, inherited: Style): string {
    // a string with newlines (the callout bar is one Text of bars) paints one row per line
    if (typeof node === 'string') return node.split('\n').map(line => open(inherited) + line + RESET).join('\n')
    const p = node.props
    const s: Style = {
      ...inherited,
      ...(typeof p.color === 'string' ? { fg: p.color } : {}),
      ...(typeof p.backgroundColor === 'string' ? { bg: p.backgroundColor } : {}),
      ...(p.bold || p.weight === 'semibold' || p.weight === 'bold' ? { bold: true } : {}),
      ...(p.dimColor ? { dim: true } : {}),
      ...(p.italic ? { italic: true } : {}),
      ...(p.underline ? { underline: true } : {}),
    }
    if (node.type === 'Button') return open({ ...s, dim: true }) + button(String(p.label ?? '')) + RESET
    if (node.type === 'Raster') return open({ ...s, dim: true }) + `<clock>` + RESET
    if (node.type === 'Link') return open({ ...s, underline: true }) + (p.children ?? []).map(c => inline(c, s)).join('') + RESET
    return (p.children ?? []).map(c => inline(c, s)).join('')
  }

  function visible(s: string): number {
    return s.replace(/\x1b\[[0-9;]*m/g, '').length
  }

  // rows of a tree: a column Box stacks, a row Box joins; margins indent.
  // `room` is the width the node may fill: the terminal less the margins and
  // widths above it, so a `space-between` row can push its last child to its
  // right edge (the duration lane, the dots line's buttons).
  function rows(node: Node, inherited: Style = {}, room = columns): string[] {
    if (typeof node === 'string') return inline(node, inherited).split('\n')
    const p = node.props
    if (p.display === 'none') return []
    if (node.type !== 'Box') return inline(node, inherited).split('\n')
    const s: Style = { ...inherited, ...(typeof p.backgroundColor === 'string' ? { bg: p.backgroundColor } : {}) }
    const kids = p.children ?? []
    const left = typeof p.marginLeft === 'number' ? ' '.repeat(p.marginLeft) : ''
    const top = typeof p.marginTop === 'number' ? p.marginTop : 0
    const inner = typeof p.width === 'number' ? p.width : room - left.length - (typeof p.marginRight === 'number' ? p.marginRight : 0)
    let out: string[]
    if (p.flexDirection === 'row') {
      const parts = kids.map(k => rows(k, s, inner))
      const height = Math.max(1, ...parts.map(r => r.length))
      out = []
      // a child with flexGrow takes the room the others leave, so a right
      // lane (the duration) ends at the row's edge
      const grow = kids.findIndex(k => typeof k !== 'string' && typeof k.props.flexGrow === 'number' && k.props.flexGrow > 0)
      for (let i = 0; i < height; i++) {
        const cells = parts.map(r => r[i] ?? '')
        const used = cells.reduce((n, c) => n + visible(c), 0)
        const gap = ' '.repeat(Math.max(0, inner - used))
        if (p.justifyContent === 'space-between' && cells.length > 1) {
          out.push(cells.slice(0, -1).join('') + gap + cells[cells.length - 1])
        } else if (grow >= 0 && cells.length > 1) {
          out.push(cells.map((c, j) => (j === grow ? c + gap : c)).join(''))
        } else {
          out.push(cells.join(''))
        }
      }
    } else {
      out = kids.flatMap(k => rows(k, s, inner))
    }
    if (typeof p.width === 'number') {
      // a box with a width fills it; a tinted one paints the fill, as the terminal does
      out = out.map(r => r + (s.bg ? open({ bg: s.bg }) : '') + ' '.repeat(Math.max(0, (p.width as number) - visible(r))) + (s.bg ? RESET : ''))
    }
    return [...Array<string>(top).fill(''), ...out.map(r => left + r)]
  }

  return { rows, rgb, open, visible, RESET }
}

// ---- SGR rows to HTML ----------------------------------------------------------

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * One painted row as HTML spans: the truecolor foreground and background,
 * bold, dim (as opacity), italic and underline the painter emits, nothing
 * else. `dimAlpha` is how faint a dim run draws.
 */
export function rowToHtml(line: string, dimAlpha = 0.6): string {
  let fg: string | null = null
  let bg: string | null = null
  let bold = false
  let dim = false
  let italic = false
  let underline = false
  let out = ''
  let i = 0
  const flush = (text: string) => {
    if (!text) return
    const css: string[] = []
    if (fg) css.push(`color:${fg}`)
    if (bg) css.push(`background:${bg}`)
    if (bold) css.push('font-weight:700')
    if (dim) css.push(`opacity:${dimAlpha}`)
    if (italic) css.push('font-style:italic')
    if (underline) css.push('text-decoration:underline')
    out += css.length ? `<span style="${css.join(';')}">${escapeHtml(text)}</span>` : escapeHtml(text)
  }
  while (i < line.length) {
    const m = /^\x1b\[([0-9;]*)m/.exec(line.slice(i))
    if (m) {
      const codes = m[1]!.split(';').map(Number)
      for (let k = 0; k < codes.length; k++) {
        const c = codes[k]!
        if (c === 0) { fg = null; bg = null; bold = false; dim = false; italic = false; underline = false }
        else if (c === 1) bold = true
        else if (c === 2) dim = true
        else if (c === 3) italic = true
        else if (c === 4) underline = true
        else if ((c === 38 || c === 48) && codes[k + 1] === 2) {
          const hex = '#' + [codes[k + 2], codes[k + 3], codes[k + 4]].map(v => (v ?? 0).toString(16).padStart(2, '0')).join('')
          if (c === 38) fg = hex
          else bg = hex
          k += 4
        }
      }
      i += m[0].length
      continue
    }
    const next = line.indexOf('\x1b[', i)
    const end = next === -1 ? line.length : next
    flush(line.slice(i, end))
    i = end
  }
  return out
}
