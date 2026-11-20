import { expect, test } from 'claude-code/testing'

import { parseMarkdown } from '../hooks/markdown'
import { StreamStore, flushShows, markerFor, seqIn, tailFit, tailRows } from '../hooks/stream'
import { cellWidth } from '../hooks/width'

test('a marker round-trips its sequence number and takes no cells', async () => {
  for (const n of [0, 1, 2, 7, 64, 1000]) {
    expect(seqIn(markerFor(n))).toBe(n)
    expect(cellWidth(markerFor(n))).toBe(0)
  }
  expect(seqIn('plain reply text')).toBeUndefined()
  expect(seqIn('')).toBeUndefined()
})

test('the store hands back the whole streamed text for a marker', async () => {
  const s = new StreamStore()
  const a = s.add('msg-a', '# Tides\n')
  s.add('msg-a', 'The Moon pulls.\n')
  const b = s.add('msg-b', 'Second reply.\n')
  expect(a).toBe(0)
  expect(b).toBe(1)
  expect(s.textFor(markerFor(a))).toBe('# Tides\nThe Moon pulls.\n')
  expect(s.textFor(markerFor(b))).toBe('Second reply.\n')
  expect(s.textFor('no marker here')).toBeUndefined()
  expect(s.textFor(markerFor(9))).toBeUndefined()
})

test('a row drawn mid-stream changes its text on the last flush, so it redraws whole', async () => {
  // 2026-11-20: the row drew once after the first flush and its text (the
  // marker) never changed again, so it kept "Bottom line" over an empty card
  const flushes = ['**Bottom line**\n', '- **Verified:** ran it.\n', '- **Issue:** drawn once.\n', '- **Fix:** redraw at the end.']
  const s = new StreamStore()
  const rows: string[] = []
  flushes.forEach((delta, i) => {
    const seq = s.add('msg-a', delta)
    rows.push((rows[i - 1] ?? '') + flushShows(seq, i, i === flushes.length - 1))
  })
  // the engine redraws a row when its text changes: between flushes it
  // does not, and the last flush changes it
  expect(rows[1]).toBe(rows[0])
  expect(rows[3]).not.toBe(rows[2])
  expect(s.textFor(rows[3]!)).toBe(flushes.join(''))
})

test('a row whose first flush showed its own lines still draws the whole reply', async () => {
  // the first flush passes through when the layout is not yet known
  const flushes = [
    '**Bottom line**\n',
    '- **Verified:** ran it.\n',
    '- **Issue:** the hook raced.\n',
    '- **Fix:** keep every flush.\n',
    '\n## What changed\n',
    'One line.',
  ]
  const s = new StreamStore()
  let row = ''
  flushes.forEach((delta, i) => {
    const seq = s.add('msg-a', delta)
    // the first flush passed through: the layout was not yet seen
    row += i === 0 ? delta : flushShows(seq, i, i === flushes.length - 1)
  })
  expect(s.textFor(row)).toBe(flushes.join(''))
  const [card] = parseMarkdown(s.textFor(row)!)
  expect(card?.kind === 'callout' ? card.rows.map(r => r.label) : []).toEqual(['Verified', 'Issue', 'Fix'])
})

test('the marker sits on the first flush and the last, nothing between', async () => {
  expect(flushShows(3, 0, false)).toBe(markerFor(3))
  expect(flushShows(3, 1, false)).toBe('')
  expect(flushShows(3, 4, true)).toBe(markerFor(3))
  expect(flushShows(3, 0, true)).toBe(markerFor(3))
  expect(cellWidth(markerFor(3) + markerFor(3))).toBe(0)
})

test('the store forgets the oldest replies past its cap', async () => {
  const s = new StreamStore(2)
  const first = s.add('one', 'a')
  s.add('two', 'b')
  s.add('three', 'c')
  expect(s.textFor(markerFor(first))).toBeUndefined()
  expect(s.textFor(markerFor(2))).toBe('c')
})

test('the live box leaves room for the turn under it', async () => {
  expect(tailRows(33)).toBe(11)
  expect(tailRows(24)).toBe(3)
  expect(tailRows(10)).toBe(3)
  expect(tailRows(200)).toBe(30)
})

test('the tail keeps the newest lines that fit, counting wrapped rows', async () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`)
  const plain = tailFit(lines.join('\n'), 5, 80)
  expect(plain.split('\n')).toEqual(['line 35', 'line 36', 'line 37', 'line 38', 'line 39'])
  // a 25-cell line wraps to 3 rows at 10 cells: two of them fill 6 rows
  const long = ['x'.repeat(25), 'y'.repeat(25), 'z'.repeat(25)].join('\n')
  expect(tailFit(long, 6, 10).split('\n').length).toBe(2)
  // the newest line always shows, even alone past the budget
  expect(tailFit('a\n' + 'w'.repeat(100), 2, 10)).toBe('w'.repeat(100))
  expect(tailFit('short\n\n', 5, 80)).toBe('short')
})

test('a tail cut inside a code fence reopens it', async () => {
  const body = Array.from({ length: 20 }, (_, i) => `x = ${i}`)
  const cut = tailFit(['intro', '```py', ...body].join('\n'), 4, 80)
  expect(cut.split('\n')).toEqual(['```', 'x = 16', 'x = 17', 'x = 18', 'x = 19'])
  const closed = tailFit(['```', 'a', '```', 'after one', 'after two'].join('\n'), 2, 80)
  expect(closed).toBe('after one\nafter two')
})
