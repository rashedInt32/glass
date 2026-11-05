// /storage (0.19.0): the desktop app's storage page for the terminal.
//
// `/storage` prints how much disk Claude Code holds: transcripts by project,
// the installed CLI versions, plugins, file history and Claude's worktrees.
// It answers with no model turn.
//
// `/storage clean [days]` finds what is safe to clear: sessions idle for
// `days` (30 by default), CLI versions no live process runs, and Claude
// worktrees (under <repo>/.claude/worktrees) with no uncommitted changes,
// on a branch, and not locked by a live session. It asks in the engine's own dialog which groups to clear, and
// deletes nothing unless the person picks one.
//
// The mod API has no delete call, so removal runs `rm` and `git worktree` by
// argument vector (no shell). Every rm target passes `isSafeTarget` first:
// a session file or folder named by a session id under the transcripts or
// file-history root, or a version folder under the versions root. A
// project's `memory/` folder is never a target.
import type { EngineInterface } from 'claude-code'

export const DEFAULT_DAYS = 30
const DAY_MS = 86_400_000
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const VERSION = /^\d+\.\d+\.\d+$/
const RM_BATCH = 200
const TOP_PROJECTS = 8

export type Roots = {
  home: string
  /** ~/.claude */
  config: string
  /** ~/.claude/projects */
  projects: string
  /** ~/.claude/file-history */
  history: string
  /** ~/.local/share/claude/versions */
  versions: string
  /** ~/.local/state/claude/locks: `<version>#<pid>.lock` per live process */
  locks: string
}

export type Session = {
  project: string
  id: string
  bytes: number
  mtimeMs: number
  /** the transcript, its folder and its file-history folder, those that exist */
  paths: string[]
}

export type Project = { name: string; label: string; bytes: number; sessions: number }

export type Version = { name: string; path: string; bytes: number; current: boolean }

export type Worktree = { repo: string; path: string; bytes: number; clean: boolean; missing: boolean }

export type Snapshot = {
  now: number
  currentSession: string
  configBytes: number
  pluginsBytes: number
  historyBytes: number
  projects: Project[]
  sessions: Session[]
  versions: Version[]
  worktrees: Worktree[]
}

export type Plan = {
  days: number
  sessions: Session[]
  versions: Version[]
  worktrees: Worktree[]
}

export function rootsFor(home: string): Roots {
  const config = `${home}/.claude`
  return {
    home,
    config,
    projects: `${config}/projects`,
    history: `${config}/file-history`,
    versions: `${home}/.local/share/claude/versions`,
    locks: `${home}/.local/state/claude/locks`,
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** `du -sk` output -> bytes by path */
export function parseDu(stdout: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab < 1) continue
    const kb = Number(line.slice(0, tab))
    if (Number.isFinite(kb)) out.set(line.slice(tab + 1), kb * 1024)
  }
  return out
}

/** the engine's project folder name for a working directory */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

/** `[clean] [days]` -> what the command was asked */
export function parseArgs(args: string): { clean: boolean; days: number } | { error: string } {
  const words = args.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { clean: false, days: DEFAULT_DAYS }
  if (words[0] !== 'clean' || words.length > 2) return { error: 'Usage: /storage, or /storage clean [days]' }
  if (words.length === 1) return { clean: true, days: DEFAULT_DAYS }
  const days = Number(words[1])
  if (!Number.isInteger(days) || days < 1) return { error: 'days must be a whole number of 1 or more' }
  return { clean: true, days }
}

/** a path rm may touch: named by a session id or version under its own root */
export function isSafeTarget(path: string, roots: Roots): boolean {
  if (path.includes('/../') || path.endsWith('/..')) return false
  const under = (root: string) => (path.startsWith(root + '/') ? path.slice(root.length + 1).split('/') : null)
  const inProjects = under(roots.projects)
  if (inProjects) {
    const [project, name, ...rest] = inProjects
    return Boolean(project) && rest.length === 0 && name !== undefined && SESSION_ID.test(name.replace(/\.jsonl$/, ''))
  }
  const inHistory = under(roots.history)
  if (inHistory) return inHistory.length === 1 && SESSION_ID.test(inHistory[0] ?? '')
  const inVersions = under(roots.versions)
  if (inVersions) return inVersions.length === 1 && VERSION.test(inVersions[0] ?? '')
  return false
}

export function planFrom(snap: Snapshot, days: number): Plan {
  const cutoff = snap.now - days * DAY_MS
  return {
    days,
    sessions: snap.sessions.filter(s => s.mtimeMs < cutoff && s.id !== snap.currentSession),
    versions: snap.versions.filter(v => !v.current),
    worktrees: snap.worktrees.filter(w => w.clean || w.missing),
  }
}

const sum = (xs: readonly { bytes: number }[]) => xs.reduce((n, x) => n + x.bytes, 0)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function rows(pairs: ReadonlyArray<[string, string]>, indent = '  '): string[] {
  const wide = Math.max(...pairs.map(([, size]) => size.length))
  return pairs.map(([label, size]) => `${indent}${size.padStart(wide)}  ${label}`)
}

export function reportText(snap: Snapshot, days = DEFAULT_DAYS): string {
  const transcripts = sum(snap.projects)
  const versions = sum(snap.versions)
  const worktrees = sum(snap.worktrees)
  const other = Math.max(0, snap.configBytes - transcripts - snap.pluginsBytes - snap.historyBytes)
  const total = snap.configBytes + versions + worktrees
  const plan = planFrom(snap, days)
  const lines = [`Claude Code uses ${formatBytes(total)} on this computer.`, '']
  lines.push(
    ...rows([
      [`Transcripts, ${plural(snap.sessions.length, 'session')} in ${plural(snap.projects.length, 'project')}`, formatBytes(transcripts)],
      [`CLI versions, ${snap.versions.length} installed`, formatBytes(versions)],
      ['Plugins', formatBytes(snap.pluginsBytes)],
      ['File history', formatBytes(snap.historyBytes)],
      [`Worktrees, ${snap.worktrees.length} under .claude/worktrees`, formatBytes(worktrees)],
      ['Everything else in ~/.claude', formatBytes(other)],
    ]),
  )
  const top = [...snap.projects].sort((a, b) => b.bytes - a.bytes).slice(0, TOP_PROJECTS)
  if (top.length) {
    lines.push('', 'Largest projects')
    lines.push(...rows(top.map(p => [`${p.label} (${plural(p.sessions, 'session')})`, formatBytes(p.bytes)] as [string, string])))
  }
  const freeable = sum(plan.sessions) + sum(plan.versions) + sum(plan.worktrees)
  lines.push('')
  if (freeable > 0) {
    const parts = [
      plan.sessions.length ? `${plural(plan.sessions.length, 'session')} idle ${days}+ days` : '',
      plan.versions.length ? plural(plan.versions.length, 'old CLI version') : '',
      plan.worktrees.length ? plural(plan.worktrees.length, 'unused worktree') : '',
    ].filter(Boolean)
    lines.push(`${formatBytes(freeable)} can be cleared: ${parts.join(', ')}.`, 'Run /storage clean to choose what goes. /storage clean 14 counts sessions idle 14+ days.')
  } else {
    lines.push('Nothing to clear.')
  }
  return lines.join('\n')
}

/** the dialog's options, no commas so a multi-select answer splits cleanly */
export function choicesFor(plan: Plan): { key: 'sessions' | 'versions' | 'worktrees'; label: string }[] {
  const out: { key: 'sessions' | 'versions' | 'worktrees'; label: string }[] = []
  if (plan.sessions.length) out.push({ key: 'sessions', label: `${plural(plan.sessions.length, 'session')} idle ${plan.days}+ days (${formatBytes(sum(plan.sessions))})` })
  if (plan.versions.length) out.push({ key: 'versions', label: `${plural(plan.versions.length, 'old CLI version')} (${formatBytes(sum(plan.versions))})` })
  if (plan.worktrees.length) out.push({ key: 'worktrees', label: `${plural(plan.worktrees.length, 'unused worktree')} (${formatBytes(sum(plan.worktrees))})` })
  return out
}

// ---- gathering --------------------------------------------------------------

async function du($: EngineInterface, paths: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (let i = 0; i < paths.length; i += 500) {
    const chunk = paths.slice(i, i + 500)
    // du exits 1 when one path is missing; the rest still print. -l: GNU du
    // prints nothing for a path nested under an earlier argument without it
    const r = await $.process.run(['du', '-skl', ...chunk], { timeoutMs: 60_000 }).catch(() => undefined)
    if (r) for (const [k, v] of parseDu(r.stdout)) out.set(k, v)
  }
  return out
}

async function list($: EngineInterface, path: string) {
  return $.fs.list(path).catch(() => [])
}

async function knownRepos($: EngineInterface, roots: Roots): Promise<string[]> {
  try {
    const json = JSON.parse(await $.fs.read(`${roots.home}/.claude.json`)) as { projects?: Record<string, unknown> }
    return Object.keys(json.projects ?? {})
  } catch {
    return []
  }
}

/** `<version>#<pid>.lock` names -> versions whose pid is alive */
export function lockedVersions(names: readonly string[], alive: ReadonlySet<string>): string[] {
  const out = new Set<string>()
  for (const name of names) {
    const m = /^(\d+\.\d+\.\d+)#(\d+)\.lock$/.exec(name)
    if (m?.[1] && m[2] && alive.has(m[2])) out.add(m[1])
  }
  return [...out]
}

async function liveLockedVersions($: EngineInterface, roots: Roots): Promise<string[]> {
  const names = (await list($, roots.locks)).map(e => e.name)
  const pids = [...new Set(names.map(n => /#(\d+)\.lock$/.exec(n)?.[1]).filter((p): p is string => Boolean(p)))]
  if (!pids.length) return []
  // every live pid, not `ps -p <list>`: macOS ps prints nothing at all when
  // one pid in the list is out of range, as a stale lock's may be
  const r = await $.process.run(['ps', '-axo', 'pid='], { timeoutMs: 10_000 }).catch(() => undefined)
  // ps failing: count every lock as live, so no locked version is offered
  const alive = r?.exitCode === 0 ? new Set(r.stdout.split(/\s+/).filter(Boolean)) : new Set(pids)
  return lockedVersions(names, alive)
}

async function worktreesOf($: EngineInterface, repo: string, sessionCwd: string): Promise<Omit<Worktree, 'bytes'>[]> {
  const r = await $.process.run(['git', '-C', repo, 'worktree', 'list', '--porcelain'], { timeoutMs: 10_000 }).catch(() => undefined)
  if (!r || r.exitCode !== 0) return []
  const out: Omit<Worktree, 'bytes'>[] = []
  for (const block of r.stdout.split('\n\n')) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    if (!path || !path.includes('/.claude/worktrees/')) continue
    // the session's own worktree is in use
    if (sessionCwd === path || sessionCwd.startsWith(path + '/')) continue
    // locked: the engine locks every worktree a live session or agent uses,
    // and git refuses to remove one. Detached: its commits may sit on no
    // branch (a checkout of a sha, a rebase stopped partway), and removing
    // the worktree drops the only ref to them
    if (/^(locked|detached)\b/m.test(block)) continue
    const missing = /^prunable/m.test(block) || !(await $.fs.exists(path))
    let clean = false
    if (!missing) {
      const s = await $.process.run(['git', '-C', path, 'status', '--porcelain'], { timeoutMs: 10_000 }).catch(() => undefined)
      clean = s?.exitCode === 0 && s.stdout.trim() === ''
    }
    out.push({ repo, path, clean, missing })
  }
  return out
}

export async function gather($: EngineInterface, roots: Roots): Promise<Snapshot> {
  const now = await $.clock.now()
  const currentSession = await $.session.id().catch(() => '')
  const sessionCwd = await $.session.cwd().catch(() => '')
  const repos = await knownRepos($, roots)
  const labelOf = new Map(repos.map(r => [projectDirName(r), r.startsWith(roots.home + '/') ? '~' + r.slice(roots.home.length) : r]))

  // sessions: <project>/<id>.jsonl, <project>/<id>/, file-history/<id>/
  const projectDirs = (await list($, roots.projects)).filter(e => e.kind === 'dir')
  const historyIds = new Set((await list($, roots.history)).filter(e => e.kind === 'dir').map(e => e.name))
  const sessions: Session[] = []
  const sizePaths: string[] = []
  for (const dir of projectDirs) {
    const entries = await list($, `${roots.projects}/${dir.name}`)
    const dirs = new Set(entries.filter(e => e.kind === 'dir').map(e => e.name))
    for (const e of entries) {
      if (e.kind !== 'file' || !e.name.endsWith('.jsonl')) continue
      const id = e.name.slice(0, -6)
      if (!SESSION_ID.test(id)) continue
      const paths = [`${roots.projects}/${dir.name}/${e.name}`]
      if (dirs.has(id)) paths.push(`${roots.projects}/${dir.name}/${id}`)
      if (historyIds.has(id)) paths.push(`${roots.history}/${id}`)
      sizePaths.push(...paths.slice(1))
      sessions.push({ project: dir.name, id, bytes: e.size, mtimeMs: e.mtimeMs, paths })
    }
  }

  // versions in use: the one ~/.local/bin/claude leads to, this session's, and
  // every version a live process holds a lock on. The updater moves the
  // symlink under running sessions, so the symlink alone misses older ones
  const inUse = new Set<string>()
  const linked = await $.fs.stat(`${roots.home}/.local/bin/claude`, { resolve: true }).catch(() => undefined)
  // by name: realPath resolves /tmp to /private/tmp and the like
  const linkedName = linked?.realPath?.split('/').pop()
  if (linkedName) inUse.add(linkedName)
  const own = await $.session.version().catch(() => undefined)
  if (own?.version) inUse.add(own.version)
  for (const v of await liveLockedVersions($, roots)) inUse.add(v)
  const versionDirs = (await list($, roots.versions)).filter(e => VERSION.test(e.name))
  const versionPaths = versionDirs.map(e => `${roots.versions}/${e.name}`)

  // worktrees: each known repo with a .claude/worktrees folder
  // by git's own path: one repo can sit under two keys (/tmp and /private/tmp,
  // a repo and its subfolder), and each lists the same worktrees
  const byPath = new Map<string, Omit<Worktree, 'bytes'>>()
  for (const repo of repos) {
    if (!(await $.fs.exists(`${repo}/.claude/worktrees`))) continue
    for (const w of await worktreesOf($, repo, sessionCwd)) if (!byPath.has(w.path)) byPath.set(w.path, w)
  }
  const candidates = [...byPath.values()]

  const projectPaths = projectDirs.map(d => `${roots.projects}/${d.name}`)
  const top = [roots.config, `${roots.config}/plugins`, roots.history]
  const sizes = await du($, [...top, ...projectPaths, ...sizePaths, ...versionPaths, ...candidates.filter(w => !w.missing).map(w => w.path)])
  const size = (p: string) => sizes.get(p) ?? 0

  for (const s of sessions) for (const p of s.paths.slice(1)) s.bytes += size(p)
  const count = new Map<string, number>()
  for (const s of sessions) count.set(s.project, (count.get(s.project) ?? 0) + 1)

  return {
    now,
    currentSession,
    configBytes: size(roots.config),
    pluginsBytes: size(`${roots.config}/plugins`),
    historyBytes: size(roots.history),
    projects: projectDirs.map(d => ({ name: d.name, label: labelOf.get(d.name) ?? d.name, bytes: size(`${roots.projects}/${d.name}`), sessions: count.get(d.name) ?? 0 })),
    sessions,
    versions: versionDirs.map(e => {
      const path = `${roots.versions}/${e.name}`
      // a version entry may be the binary itself
      return { name: e.name, path, bytes: size(path) || e.size, current: inUse.has(e.name) }
    }),
    worktrees: candidates.map(w => ({ ...w, bytes: w.missing ? 0 : size(w.path) })),
  }
}

// ---- clearing ---------------------------------------------------------------

async function rm($: EngineInterface, paths: readonly string[], roots: Roots): Promise<number> {
  const safe = paths.filter(p => isSafeTarget(p, roots))
  let failed = paths.length - safe.length
  for (let i = 0; i < safe.length; i += RM_BATCH) {
    const r = await $.process.run(['rm', '-rf', '--', ...safe.slice(i, i + RM_BATCH)], { timeoutMs: 120_000 }).catch(() => undefined)
    if (!r || r.exitCode !== 0) failed += 1
  }
  return failed
}

export async function clear($: EngineInterface, plan: Plan, keys: ReadonlySet<string>, roots: Roots): Promise<string> {
  const done: string[] = []
  const problems: string[] = []
  if (keys.has('sessions') && plan.sessions.length) {
    const failed = await rm($, plan.sessions.flatMap(s => s.paths), roots)
    done.push(`${plural(plan.sessions.length, 'session')} (${formatBytes(sum(plan.sessions))})`)
    if (failed) problems.push('some session files could not be removed')
  }
  if (keys.has('versions') && plan.versions.length) {
    const failed = await rm($, plan.versions.map(v => v.path), roots)
    done.push(`${plural(plan.versions.length, 'old CLI version')} (${formatBytes(sum(plan.versions))})`)
    if (failed) problems.push('some versions could not be removed')
  }
  if (keys.has('worktrees') && plan.worktrees.length) {
    let removed = 0
    for (const w of plan.worktrees) {
      // no --force: git refuses a worktree that changed since the scan; its
      // branch stays. A missing one goes the same way, its entry alone: a
      // bare `worktree prune` would drop every prunable worktree in the repo
      const r = await $.process.run(['git', '-C', w.repo, 'worktree', 'remove', w.path], { timeoutMs: 60_000 }).catch(() => undefined)
      if (r?.exitCode === 0) removed += 1
      else problems.push(`git kept ${w.path}${r?.stderr ? ': ' + r.stderr.trim().split('\n')[0] : ''}`)
    }
    if (removed) done.push(`${plural(removed, 'worktree')} (branches kept)`)
  }
  const lines = [done.length ? `Cleared ${done.join(', ')}.` : 'Nothing cleared.']
  if (problems.length) lines.push(...problems.map(p => `  ${p}`))
  return lines.join('\n')
}
