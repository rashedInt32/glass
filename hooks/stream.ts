// Classic-renderer streaming (0.21.0). Under Claude Code's main-screen
// renderer (CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1) a reply streams into the
// terminal's scrollback in the engine's own style. When it finishes, glass's
// AssistantMessage hook answers a moment later, the frame shrinks for that
// one frame, and the engine reprints the turn under the copy already in
// scrollback: every reply taller than the screen lands twice (engine 2.1.322,
// "Full reset (shrink->below)"). So in that mode glass keeps the reply out of
// scrollback while it streams: each MessageDisplay flush shows an invisible
// marker instead of its lines, the text streams into a capped box above the
// prompt, and the finished row draws the stored text in glass's style.
// ASCII-only source; the marker glyphs come from code points.

import { cellWidth } from './width'

// all three are zero cells wide for the engine's ruler (Bun.stringWidth)
// and for cellWidth; U+2063 is one cell there, so it is not used
const START = String.fromCodePoint(0x200e) // left-to-right mark
const ZERO = String.fromCodePoint(0x200b) // zero-width space
const ONE = String.fromCodePoint(0x200c) // zero-width non-joiner
const MARKER = new RegExp(`${START}([${ZERO}${ONE}]+)${START}`)

/** The marker a message's first flush shows in place of its lines. */
export function markerFor(seq: number): string {
  const bits = Math.max(0, Math.floor(seq)).toString(2)
  return START + [...bits].map(b => (b === '1' ? ONE : ZERO)).join('') + START
}

/** The sequence number a displayed text carries, undefined without a marker. */
export function seqIn(text: string): number | undefined {
  const bits = MARKER.exec(text)?.[1]
  if (bits === undefined) return undefined
  return parseInt([...bits].map(c => (c === ONE ? '1' : '0')).join(''), 2)
}

/**
 * The streamed text of the newest messages, by the engine's message_id, and
 * the sequence number each one's marker carries.
 */
export class StreamStore {
  private readonly texts = new Map<string, string>()
  private readonly seqs = new Map<string, number>()
  private readonly ids: string[] = []
  private next = 0

  constructor(private readonly cap = 64) {}

  /** Adds a flush's lines; answers the message's sequence number. */
  add(id: string, delta: string): number {
    let seq = this.seqs.get(id)
    if (seq === undefined) {
      seq = this.next++
      this.seqs.set(id, seq)
      this.ids[seq] = id
      this.texts.set(id, '')
      // forget the oldest past the cap; their rows keep the marker and draw
      // empty, which only a redraw of a very old reply could show
      for (const old of this.texts.keys()) {
        if (this.texts.size <= this.cap) break
        this.texts.delete(old)
      }
    }
    this.texts.set(id, (this.texts.get(id) ?? '') + delta)
    return seq
  }

  /** The text a displayed marker stands for, undefined when it has none or it was forgotten. */
  textFor(displayed: string): string | undefined {
    const seq = seqIn(displayed)
    if (seq === undefined) return undefined
    const id = this.ids[seq]
    return id === undefined ? undefined : this.texts.get(id)
  }
}

/** The live box's height in rows: what the screen leaves under the turn's live rows. */
export function tailRows(viewportRows: number): number {
  return Math.max(3, Math.min(30, Math.floor(viewportRows) - 22))
}

/**
 * The newest lines of a streaming reply that fit in `rows` screen rows at
 * `width` cells, a long line counting the rows it wraps to. A cut inside a
 * code fence reopens it. The box draws these lines at their natural height:
 * a fixed-height box made the layout squeeze each paragraph to one row.
 */
export function tailFit(text: string, rows: number, width: number): string {
  const lines = text.replace(/\n+$/, '').split('\n')
  const w = Math.max(1, width)
  let used = 0
  let start = lines.length
  while (start > 0) {
    const line = lines[start - 1] ?? ''
    const need = Math.max(1, Math.ceil(cellWidth(line) / w))
    if (used + need > rows && start < lines.length) break
    used += need
    start--
  }
  const fences = lines.slice(0, start).filter(l => /^\s*(```|~~~)/.test(l)).length
  const tail = lines.slice(start)
  return (fences % 2 === 1 ? ['```', ...tail] : tail).join('\n')
}
