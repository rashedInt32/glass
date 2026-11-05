import { expect, test } from 'claude-code/testing'

import { choicesFor, formatBytes, isSafeTarget, lockedVersions, parseArgs, parseDu, planFrom, projectDirName, reportText, rootsFor } from '../hooks/storage'
import type { Snapshot } from '../hooks/storage'

const R = rootsFor('/Users/me')
const ID = '024d37e8-e641-41d3-a26d-b4e6b10b8db5'
const ID2 = '01fc87ef-76e2-4158-b45a-99f131d9e805'
const NOW = 1_800_000_000_000
const DAY = 86_400_000

function snap(): Snapshot {
  return {
    now: NOW,
    currentSession: ID2,
    configBytes: 3 * 1024 ** 3,
    pluginsBytes: 300 * 1024 ** 2,
    historyBytes: 60 * 1024 ** 2,
    projects: [{ name: '-Users-me-app', label: '~/app', bytes: 2 * 1024 ** 3, sessions: 3 }],
    sessions: [
      { project: '-Users-me-app', id: ID, bytes: 500 * 1024 ** 2, mtimeMs: NOW - 40 * DAY, paths: [`${R.projects}/-Users-me-app/${ID}.jsonl`] },
      // the running session is never offered, however old its file looks
      { project: '-Users-me-app', id: ID2, bytes: 10, mtimeMs: NOW - 400 * DAY, paths: [] },
      { project: '-Users-me-app', id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', bytes: 10, mtimeMs: NOW - 2 * DAY, paths: [] },
    ],
    versions: [
      { name: '2.1.316', path: `${R.versions}/2.1.316`, bytes: 296 * 1024 ** 2, current: false },
      { name: '2.1.318', path: `${R.versions}/2.1.318`, bytes: 305 * 1024 ** 2, current: true },
    ],
    worktrees: [
      { repo: '/r', path: '/r/.claude/worktrees/a', bytes: 1024, clean: true, missing: false },
      { repo: '/r', path: '/r/.claude/worktrees/b', bytes: 2048, clean: false, missing: false },
      { repo: '/r', path: '/r/.claude/worktrees/c', bytes: 0, clean: false, missing: true },
    ],
  }
}

test('parseArgs: bare, clean, clean with days, and refusals', async () => {
  expect(parseArgs('')).toEqual({ clean: false, days: 30 })
  expect(parseArgs('  clean ')).toEqual({ clean: true, days: 30 })
  expect(parseArgs('clean 14')).toEqual({ clean: true, days: 14 })
  expect('error' in parseArgs('clean 0')).toBe(true)
  expect('error' in parseArgs('clean 1.5')).toBe(true)
  expect('error' in parseArgs('wipe')).toBe(true)
  expect('error' in parseArgs('clean 3 extra')).toBe(true)
})

test('isSafeTarget allows session files, session folders and versions, nothing else', async () => {
  expect(isSafeTarget(`${R.projects}/-Users-me-app/${ID}.jsonl`, R)).toBe(true)
  expect(isSafeTarget(`${R.projects}/-Users-me-app/${ID}`, R)).toBe(true)
  expect(isSafeTarget(`${R.history}/${ID}`, R)).toBe(true)
  expect(isSafeTarget(`${R.versions}/2.1.316`, R)).toBe(true)
  // memory, project folders, the roots themselves, traversal and outside paths stay
  expect(isSafeTarget(`${R.projects}/-Users-me-app/memory`, R)).toBe(false)
  expect(isSafeTarget(`${R.projects}/-Users-me-app`, R)).toBe(false)
  expect(isSafeTarget(R.projects, R)).toBe(false)
  expect(isSafeTarget(`${R.projects}/-Users-me-app/${ID}/x`, R)).toBe(false)
  expect(isSafeTarget(`${R.projects}/../${ID}`, R)).toBe(false)
  expect(isSafeTarget(`${R.versions}/latest`, R)).toBe(false)
  expect(isSafeTarget(`/Users/me/${ID}.jsonl`, R)).toBe(false)
  expect(isSafeTarget(`${R.history}/${ID}/..`, R)).toBe(false)
})

test('planFrom: idle sessions but never the running one, old versions, clean or missing worktrees', async () => {
  const plan = planFrom(snap(), 30)
  expect(plan.sessions.map(s => s.id)).toEqual([ID])
  expect(plan.versions.map(v => v.name)).toEqual(['2.1.316'])
  expect(plan.worktrees.map(w => w.path)).toEqual(['/r/.claude/worktrees/a', '/r/.claude/worktrees/c'])
  expect(planFrom(snap(), 60).sessions.length).toBe(0)
})

test('choicesFor: one comma-free label per non-empty group', async () => {
  const choices = choicesFor(planFrom(snap(), 30))
  expect(choices.map(c => c.key)).toEqual(['sessions', 'versions', 'worktrees'])
  for (const c of choices) expect(c.label.includes(',')).toBe(false)
  expect(choices[0]?.label).toBe('1 session idle 30+ days (500 MB)')
  expect(choicesFor({ days: 30, sessions: [], versions: [], worktrees: [] })).toEqual([])
})

test('reportText names the totals, the largest project and what can be cleared', async () => {
  const text = reportText(snap())
  expect(text.includes('Claude Code uses 3.6 GB on this computer.')).toBe(true)
  expect(text.includes('~/app (3 sessions)')).toBe(true)
  expect(text.includes('Run /storage clean')).toBe(true)
  const empty = { ...snap(), sessions: [], versions: [], worktrees: [] }
  expect(reportText(empty).endsWith('Nothing to clear.')).toBe(true)
})

test('lockedVersions keeps versions whose lock pid is alive, once each', async () => {
  const names = ['2.1.318#44896.lock', '2.1.318#48117.lock', '2.1.318.lock', '2.1.316#100.lock', '2.1.314#200.lock', 'junk']
  expect(lockedVersions(names, new Set(['44896', '100'])).sort()).toEqual(['2.1.316', '2.1.318'])
  expect(lockedVersions(names, new Set())).toEqual([])
})

test('parseDu, formatBytes and projectDirName', async () => {
  const sizes = parseDu('12\t/a b\n3\t/c\nnoise\n')
  expect(sizes.get('/a b')).toBe(12 * 1024)
  expect(sizes.get('/c')).toBe(3 * 1024)
  expect(sizes.size).toBe(2)
  expect(formatBytes(512)).toBe('512 B')
  expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB')
  expect(projectDirName('/Users/rashed/.claude')).toBe('-Users-rashed--claude')
})
