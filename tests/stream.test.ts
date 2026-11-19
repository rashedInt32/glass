import { expect, test } from 'claude-code/testing'

import { StreamStore, markerFor, seqIn, tailFit, tailRows } from '../hooks/stream'
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
