// 0.6.0: an MCP screenshot draws under its row, the picture Claude read.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { CONVERTIBLE, hashOf, lastPictureRead, namedIn, pictureOf, pngSize, shotBox, shotFromPng, shotOf } from '../hooks/shot'

// a PNG header for a picture `w` by `h`: the signature, then IHDR
function pngHeader(w: number, h: number): string {
  const b = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]
  for (const n of [w, h]) b.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255)
  // bit depth, colour type, three flags, and a CRC byte: 30 bytes, no base64 padding
  b.push(8, 6, 0, 0, 0, 0)
  return btoa(String.fromCharCode(...b))
}
// a whole 1x1 PNG, for trees the validator reads
const ONE_PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const STORED = '/Users/someone/.claude/projects/p/s/tool-results/mcp-chrome-devtools-blob-1-abc.png'

// the result as the engine handed it over live (probe, 2026-10-12)
const engineResult = (data: string, mime = 'image/png', stored: string | null = STORED) => [
  { type: 'text', text: "Took a screenshot of the current page's viewport." },
  { type: 'image', source: { type: 'base64', media_type: mime, data } },
  ...(stored ? [{ type: 'text', text: `[Image: source: ${stored}, original 2400x1658, displayed at 2000x1382. Multiply coordinates by 1.20 to map to original image.]` }] : []),
]

test('the size comes from the PNG header', () => {
  expect(pngSize(pngHeader(2000, 1382))).toEqual({ width: 2000, height: 1382 })
  expect(pngSize(ONE_PX)).toEqual({ width: 1, height: 1 })
  expect(pngSize(btoa('not a png at all, just some text here'))).toBe(null)
  expect(pngSize('***')).toBe(null)
})

test('the bytes are drawn, even when the engine names a stored copy', () => {
  const head = pngHeader(2000, 1382)
  expect(shotOf(engineResult(head))).toEqual({ source: { png: head }, width: 2000, height: 1382 })
  expect(shotOf(engineResult(ONE_PX, 'image/png', null))).toEqual({ source: { png: ONE_PX }, width: 1, height: 1 })
  // MCP's own block shape, under `content`
  expect(shotOf({ content: [{ type: 'image', data: ONE_PX, mimeType: 'image/png' }] })).toEqual({ source: { png: ONE_PX }, width: 1, height: 1 })
})

test('no picture, a JPEG, or too many bytes stays the engine\'s', () => {
  expect(shotOf(engineResult(pngHeader(10, 10), 'image/jpeg'))).toBe(null)
  expect(shotOf([{ type: 'text', text: 'Navigated to https://example.com' }])).toBe(null)
  expect(shotOf('a string')).toBe(null)
  expect(shotOf(undefined)).toBe(null)
  expect(shotOf(engineResult(pngHeader(10, 10) + 'A'.repeat(3_000_000), 'image/png', null))).toBe(null)
})

test('past 2 MiB of bytes the stored copy is drawn instead', () => {
  const big = pngHeader(2000, 9000) + 'A'.repeat(3_000_000)
  expect(shotOf(engineResult(big))).toEqual({ source: { file: STORED, format: 'png' }, width: 2000, height: 9000 })
})

test('the box keeps the aspect and stays inside its caps', () => {
  // a wide page: width-bound
  expect(shotBox(2000, 1000, 100, 40)).toEqual({ columns: 100, rows: 25 })
  // a tall page: height-bound, narrower
  expect(shotBox(1000, 4000, 100, 24)).toEqual({ columns: 12, rows: 24 })
})

// the trees go through the engine's validator: a refused tree would fall
// back to the engine's own drawing in a session
test('mounted: a screenshot result draws an Image on the trunk', { options: { screenshots: true } }, async ($, on) => {
  // the engine's own body, beneath glass
  on('ui.render', { component: 'ToolResult' }, (engine, e) => engine.ui.resolve(e).Text({ children: ['engine body'] }) as never)
  const row = await $.ui.mount({
    plugin: 'glass',
    surface: 'terminal',
    component: 'ToolResult',
    props: { tool_use_id: 'toolu_s1', tool: 'mcp__plugin_jev-reach_chrome-devtools__take_screenshot', isErrored: false, output: engineResult(ONE_PX, 'image/png', null) },
  })
  expect(await row.find({ type: 'Image' })).toBeDefined()
  await row.unmount()

  // a text-only MCP result keeps the engine's body
  const plain = await $.ui.mount({
    plugin: 'glass',
    surface: 'terminal',
    component: 'ToolResult',
    props: { tool_use_id: 'toolu_s2', tool: 'mcp__plugin_jev-reach_chrome-devtools__navigate_page', isErrored: false, output: [{ type: 'text', text: 'Navigated.' }] },
  })
  expect(await plain.find({ type: 'Image' })).toBeUndefined()
  expect(await plain.find({ type: 'Text', text: /engine body/ })).toBeDefined()
  await plain.unmount()
})

test('screenshots off: the result keeps the engine body, the group stays folded', { options: { screenshots: false } }, async ($, on) => {
  on('ui.render', { component: 'ToolResult' }, (engine, e) => engine.ui.resolve(e).Text({ children: ['engine body'] }) as never)
  on('ui.render', { component: 'ToolGroup' }, (engine, e) => engine.ui.resolve(e).Text({ children: [e.props.isExpanded ? 'opened' : 'folded'] }) as never)
  const output = engineResult(ONE_PX, 'image/png', null)
  const row = await $.ui.mount({
    plugin: 'glass',
    surface: 'terminal',
    component: 'ToolResult',
    props: { tool_use_id: 'toolu_o1', tool: 'mcp__plugin_jev-reach_chrome-devtools__take_screenshot', isErrored: false, output },
  })
  expect(await row.find({ type: 'Image' })).toBeUndefined()
  expect(await row.find({ type: 'Text', text: /engine body/ })).toBeDefined()
  await row.unmount()
  const group = await $.ui.mount({
    plugin: 'glass',
    surface: 'terminal',
    component: 'ToolGroup',
    props: {
      calls: [{ tool_use_id: 'toolu_o2', tool: 'mcp__plugin_jev-reach_chrome-devtools__take_screenshot', input: {}, isRunning: false, isErrored: false, isInterrupted: false, output }],
      isActive: false,
      isExpanded: false,
    },
  })
  // glass draws its own folded row: the engine's beneath is never asked to open
  expect(await group.find({ type: 'Text', text: /opened/ })).toBeUndefined()
  await group.unmount()
})

test('mounted: a group with a screenshot opens, and the row draws the picture', { options: { screenshots: true } }, async ($, on) => {
  // the engine's group, beneath glass: it says whether glass opened it
  on('ui.render', { component: 'ToolGroup' }, (engine, e) => engine.ui.resolve(e).Text({ children: [e.props.isExpanded ? 'opened' : 'folded'] }) as never)
  const shot = { tool_use_id: 'toolu_g2', tool: 'mcp__plugin_jev-reach_chrome-devtools__take_screenshot', input: {}, isRunning: false, isErrored: false, isInterrupted: false, output: engineResult(ONE_PX, 'image/png', null) }
  const group = await $.ui.mount({
    plugin: 'glass',
    surface: 'terminal',
    component: 'ToolGroup',
    props: {
      calls: [
        { tool_use_id: 'toolu_g1', tool: 'mcp__plugin_jev-reach_chrome-devtools__new_page', input: { url: 'https://example.com' }, isRunning: false, isErrored: false, isInterrupted: false, output: [{ type: 'text', text: 'ok' }] },
        shot,
      ],
      isActive: false,
      isExpanded: false,
    },
  })
  expect(await group.find({ type: 'Text', text: /opened/ })).toBeDefined()
  await group.unmount()
  const row = await $.ui.mount({ plugin: 'glass', surface: 'terminal', component: 'ToolUse', props: shot })
  expect(await row.find({ type: 'Image' })).toBeDefined()
  await row.unmount()
})


// ---- 0.8.0: any picture Claude looked at ------------------------------------
// the session's conversation as `$.session.messages()` hands it back: a Read
// picture draws only once glass has read it (0.17.0)
const conversation = (on: On, messages: unknown[]) =>
  on('session.messages', (() => ({ value: messages })) as never)
const readCall = (id: string, path: string, data = ONE_PX, mime = 'image/png') => ({
  tool_use_id: id, tool: 'Read', input: { file_path: path }, isRunning: false, isErrored: false, isInterrupted: false,
  output: { type: 'image', file: { base64: data, type: mime, originalSize: 70 } },
})

test('a picture from a Read, or an MCP block in any format, with its copy on disk', () => {
  expect(pictureOf({ type: 'image', file: { base64: ONE_PX, type: 'image/png' } }, '/p/a.png')).toEqual({ mime: 'image/png', data: ONE_PX, file: '/p/a.png' })
  const jpeg = [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4AAQ' } },
    { type: 'text', text: '[Image: source: /t/shot.jpg, original 2400x1658, displayed at 2000x1382.]' },
  ]
  expect(pictureOf(jpeg)).toEqual({ mime: 'image/jpeg', data: '/9j/4AAQ', file: '/t/shot.jpg' })
  expect(pictureOf({ type: 'text', file: { content: 'x' } })).toBe(null)
  expect(pictureOf([{ type: 'text', text: 'Navigated.' }])).toBe(null)
  expect(CONVERTIBLE.test('image/jpeg') && CONVERTIBLE.test('image/webp') && !CONVERTIBLE.test('image/svg+xml')).toBe(true)
})

test('a PNG draws as bytes; not a PNG, or over 2 MiB, does not', () => {
  expect(shotFromPng(ONE_PX)).toEqual({ source: { png: ONE_PX }, width: 1, height: 1 })
  expect(shotFromPng('/9j/4AAQSkZJRgABAQAAAQABAAD')).toBe(null)
  expect(shotFromPng(pngHeader(10, 10) + 'A'.repeat(3_000_000))).toBe(null)
})

test('a file the person named in a prompt, as written or under ~, is theirs', () => {
  const prompts = ['look at /Users/me/Desktop/Screenshot 1.png please', 'and ~/shots/b.png']
  expect(namedIn(prompts, '/Users/me/Desktop/Screenshot 1.png', '/Users/me')).toBe(true)
  expect(namedIn(prompts, '/Users/me/shots/b.png', '/Users/me')).toBe(true)
  expect(namedIn(prompts, '/tmp/qa/after.png', '/Users/me')).toBe(false)
  expect(namedIn(prompts, '', '/Users/me')).toBe(false)
})

test('a group draws one Read picture: the last the person did not name', () => {
  const calls = [readCall('r1', '/tmp/a.png'), readCall('r2', '/tmp/b.png'), { tool_use_id: 'g1', tool: 'Grep', input: {}, isRunning: false, isErrored: false, output: {} }]
  expect(lastPictureRead(calls, () => false)).toBe('r2')
  expect(lastPictureRead(calls, p => p === '/tmp/b.png')).toBe('r1')
  expect(lastPictureRead([{ ...readCall('r3', '/tmp/c.png'), isRunning: true }], () => false)).toBe(null)
  expect(lastPictureRead([{ tool_use_id: 'r4', tool: 'Read', input: { file_path: '/a.ts' }, output: { type: 'text', file: {} } }], () => false)).toBe(null)
})

test('mounted: two image reads in a folded group draw exactly one Image', { options: { screenshots: true } }, async ($, on) => {
  on('ui.render', { component: 'ToolGroup' }, (engine, e) => engine.ui.resolve(e).Text({ children: [e.props.isExpanded ? 'opened' : 'folded'] }) as never)
  conversation(on, [])
  const group = await $.ui.mount({
    plugin: 'glass',
    surface: 'terminal',
    component: 'ToolGroup',
    props: { calls: [readCall('m1', '/tmp/a.png'), readCall('m2', '/tmp/b.png')], isActive: false, isExpanded: false },
  })
  expect(await group.findAll({ type: 'Image' })).toHaveLength(1)
  expect(await group.find({ type: 'Text', text: /opened/ })).toBeUndefined()
  await group.unmount()
})

test('mounted: screenshots off, a folded run of image reads draws none', { options: { screenshots: false } }, async $ => {
  const group = await $.ui.mount({
    plugin: 'glass',
    surface: 'terminal',
    component: 'ToolGroup',
    props: { calls: [readCall('n1', '/tmp/a.png')], isActive: false, isExpanded: false },
  })
  expect(await group.findAll({ type: 'Image' })).toHaveLength(0)
  await group.unmount()
})

// ---- 0.17.0: the /rv findings on the 0.8.0 code, one test each -------------
// a whole 2x2 PNG, a picture other than ONE_PX
const PNG_2PX = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII='
const MINE = '/Users/me/Desktop/mine.png'
const engineBody = (on: On) => on('ui.render', { component: 'ToolResult' }, (engine, e) => engine.ui.resolve(e).Text({ children: ['engine body'] }) as never)
const submitted = (on: On) => on('prompt.submit', ((_: unknown, e: { text: string }) => ({ text: e.text })) as never)
// a ToolResult row as the engine builds it: no input
const resultRow = ($: Parameters<Parameters<typeof test>[1] & (($: never, on: never) => unknown)>[0], id: string, data = ONE_PX, mime = 'image/png') =>
  ($ as { ui: { mount: (a: unknown) => Promise<{ find: (q: unknown) => Promise<unknown>; findAll: (q: unknown) => Promise<unknown[]>; unmount: () => Promise<void> }> } }).ui.mount({
    plugin: 'glass', surface: 'terminal', component: 'ToolResult',
    props: { tool_use_id: id, tool: 'Read', isErrored: false, isExpanded: false, output: { type: 'image', file: { base64: data, type: mime } } },
  })
const useRow = ($: { ui: { mount: (a: unknown) => Promise<{ unmount: () => Promise<void> }> } }, id: string, path: string) =>
  $.ui.mount({ plugin: 'glass', surface: 'terminal', component: 'ToolUse', props: { ...readCall(id, path), isRunning: true, output: undefined } }).then(r => r.unmount())

test('0.17.0: a group that grew draws one picture when it opens, not one per Read it ever chose', { options: { screenshots: true } }, async ($, on) => {
  on('ui.render', { component: 'ToolGroup' }, (engine, e) => engine.ui.resolve(e).Text({ children: [e.props.isExpanded ? 'opened' : 'folded'] }) as never)
  conversation(on, [])
  const a = readCall('grow-a', '/tmp/a.png'), b = readCall('grow-b', '/tmp/b.png')
  const failed = { tool_use_id: 'grow-f', tool: 'Read', input: { file_path: '/tmp/gone.png' }, isRunning: false, isErrored: true, isInterrupted: false, output: 'File does not exist.' }
  for (const calls of [[a], [a, b], [a, b, failed]]) {
    const g = await $.ui.mount({ plugin: 'glass', surface: 'terminal', component: 'ToolGroup', props: { calls, isActive: true, isExpanded: false } })
    await g.unmount()
  }
  let images = 0
  for (const c of [a, b]) {
    const row = await $.ui.mount({ plugin: 'glass', surface: 'terminal', component: 'ToolUse', props: c })
    images += (await row.findAll({ type: 'Image' })).length
    await row.unmount()
  }
  expect(images).toBe(1)
})

test('0.17.0: a standalone Read row knows its file: the person\'s own picture stays text, Claude\'s draws', { options: { screenshots: true } }, async ($, on) => {
  engineBody(on)
  submitted(on)
  conversation(on, [])
  await $.prompt.submit({ text: `look at ${MINE}`, wait: false, origin: { kind: 'composer' } } as never)
  // tool.call or the ToolUse row records each Read's file; the ToolResult row has no input
  await useRow($ as never, 'own', MINE)
  await useRow($ as never, 'found', '/tmp/qa/after.png')
  const own = await resultRow($ as never, 'own')
  expect(await own.find({ type: 'Image' })).toBeUndefined()
  await own.unmount()
  const found = await resultRow($ as never, 'found')
  expect(await found.find({ type: 'Image' })).toBeDefined()
  await found.unmount()
  // a Read whose file glass never learned keeps the engine's row
  const unknown = await resultRow($ as never, 'never-seen')
  expect(await unknown.find({ type: 'Image' })).toBeUndefined()
  await unknown.unmount()
})

test('0.17.0: a resumed session reads the conversation: a picture named before the resume stays text', { options: { screenshots: true } }, async ($, on) => {
  engineBody(on)
  conversation(on, [
    { role: 'user', text: `look at ${MINE}`, toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'old-own', tool: 'Read', input: { file_path: MINE } }, { tool_use_id: 'old-found', tool: 'Read', input: { file_path: '/tmp/qa/before.png' } }] },
  ])
  const own = await resultRow($ as never, 'old-own')
  expect(await own.find({ type: 'Image' })).toBeUndefined()
  await own.unmount()
  const found = await resultRow($ as never, 'old-found')
  expect(await found.find({ type: 'Image' })).toBeDefined()
  await found.unmount()
})

test('0.17.0: a named picture stays the person\'s past 48 prompts; a task notification names none', { options: { screenshots: true } }, async ($, on) => {
  engineBody(on)
  submitted(on)
  conversation(on, [])
  await $.prompt.submit({ text: `look at ${MINE}`, wait: false, origin: { kind: 'composer' } } as never)
  for (let i = 0; i < 60; i++) await $.prompt.submit({ text: `p${i}`, wait: false, origin: { kind: 'composer' } } as never)
  await $.prompt.submit({ text: '<task-notification>agent saved /tmp/qa/agent.png</task-notification>', wait: false, origin: { kind: 'task-notification' } } as never)
  await useRow($ as never, 'late-own', MINE)
  await useRow($ as never, 'agent', '/tmp/qa/agent.png')
  const own = await resultRow($ as never, 'late-own')
  expect(await own.find({ type: 'Image' })).toBeUndefined()
  await own.unmount()
  const agent = await resultRow($ as never, 'agent')
  expect(await agent.find({ type: 'Image' })).toBeDefined()
  await agent.unmount()
})

test('0.17.0: a group opens only for a screenshot that draws; one glass cannot draw keeps it folded', async ($, on) => {
  on('ui.render', { component: 'ToolGroup' }, (engine, e) => engine.ui.resolve(e).Text({ children: [e.props.isExpanded ? 'opened' : 'folded'] }) as never)
  const page = { tool_use_id: 'bmp-1', tool: 'mcp__plugin_jev-reach_chrome-devtools__new_page', input: {}, isRunning: false, isErrored: false, isInterrupted: false, output: [{ type: 'text', text: 'ok' }] }
  const bmp = { tool_use_id: 'bmp-2', tool: 'mcp__plugin_jev-reach_chrome-devtools__take_screenshot', input: {}, isRunning: false, isErrored: false, isInterrupted: false, output: engineResult('Qk0AAAAA', 'image/bmp', null) }
  const g = await $.ui.mount({ plugin: 'glass', surface: 'terminal', component: 'ToolGroup', props: { calls: [page, bmp], isActive: false, isExpanded: false } })
  expect(await g.find({ type: 'Text', text: /opened/ })).toBeUndefined()
  await g.unmount()
})

// sips and the disk, mocked: a file exists once written, `mv` moves it, and
// a converted picture comes back as the PNG its source bytes stand for (`B...`
// a 2x2 picture, any other 1x1), so a drawn picture says which bytes it came
// from. `sizes` answers fs.stat of a converted PNG in turn; `slow` yields on
// every run so overlapping runs would show; `stuck` holds a write forever.
const DIR = '/tmp/glass-pictures-test'
const fakeDisk = (on: On, o: { sizes?: number[]; slow?: boolean; stuck?: () => boolean; delay?: () => Promise<void>; files?: Record<string, string> } = {}) => {
  const disk = new Map<string, string>(Object.entries(o.files ?? {}))
  const runs: { argv: readonly string[]; stdin?: string }[] = []
  let running = 0
  let most = 0
  on('process.run', (async (_: unknown, e: { argv: readonly string[]; init?: { stdin?: string } }) => {
    runs.push({ argv: e.argv, ...(e.init?.stdin !== undefined ? { stdin: e.init.stdin } : {}) })
    running++
    most = Math.max(most, running)
    try {
      if (o.slow) for (let i = 0; i < 5; i++) await Promise.resolve()
      const [cmd, a1, a2, a3] = e.argv
      if (cmd === 'sh' && /mkdir/.test(a2 ?? '')) return { value: { exitCode: 0, stdout: DIR, stderr: '' } }
      if (cmd === 'sh') {
        if (o.stuck?.()) return await new Promise(() => {})
        await o.delay?.()
        disk.set(a3!, e.init?.stdin ?? '')
      } else if (cmd === 'sips' && a1 === '-g') {
        return { value: { exitCode: 0, stdout: `${e.argv[5]}\n  pixelWidth: 1000\n  pixelHeight: 720\n`, stderr: '' } }
      } else if (cmd === 'sips') {
        const input = e.argv[e.argv.length - 3]!
        disk.set(e.argv[e.argv.length - 1]!, disk.get(input) ?? '')
      } else if (cmd === 'mv') {
        disk.set(e.argv[3]!, disk.get(e.argv[2]!) ?? '')
        disk.delete(e.argv[2]!)
      }
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    } finally {
      running--
    }
  }) as never)
  on('fs.stat', ((_: unknown, e: { path: string }) => {
    if (!disk.has(e.path)) return { deny: `no such file: ${e.path}` }
    const size = e.path.endsWith('.part.png') && o.sizes?.length ? o.sizes.shift()! : 100
    return { value: { kind: 'file', size } }
  }) as never)
  on('fs.read', ((_: unknown, e: { path: string }) => ({ value: { base64: (disk.get(e.path) ?? '').startsWith('B') ? PNG_2PX : ONE_PX } })) as never)
  return { runs, most: () => most, disk }
}
const imageOf = async (row: { find: (q: unknown) => Promise<unknown> }) => ((await row.find({ type: 'Image' })) as { props?: { source?: unknown } } | undefined)?.props?.source

test('0.17.0: a file read twice draws what each read saw, converted from the bytes through stdin', { options: { screenshots: true } }, async ($, on) => {
  engineBody(on)
  conversation(on, [])
  const { runs } = fakeDisk(on)
  await useRow($ as never, 'shot-1', '/tmp/shot.jpg')
  await useRow($ as never, 'shot-2', '/tmp/shot.jpg')
  const first = await resultRow($ as never, 'shot-1', 'A1jpegbytes', 'image/jpeg')
  expect(await imageOf(first)).toEqual({ png: ONE_PX })
  await first.unmount()
  const second = await resultRow($ as never, 'shot-2', 'B2jpegbytes', 'image/jpeg')
  expect(await imageOf(second)).toEqual({ png: PNG_2PX })
  await second.unmount()
  // the bytes went through stdin, never argv
  const writes = runs.filter(r => r.argv[0] === 'sh' && !/mkdir/.test(r.argv[2] ?? ''))
  expect(writes.map(r => r.stdin)).toEqual(['A1jpegbytes', 'B2jpegbytes'])
  expect(writes.every(r => r.argv.every(a => !a.includes('jpegbytes')))).toBe(true)
})

test('0.17.0: a PNG too heavy to draw shrinks from its own size, never past it', { options: { screenshots: true } }, async ($, on) => {
  engineBody(on)
  conversation(on, [])
  // as it is: 3 MB; at three quarters: small enough
  const { runs } = fakeDisk(on, { sizes: [3_000_000, 100] })
  await useRow($ as never, 'heavy', '/tmp/noise.webp')
  const row = await resultRow($ as never, 'heavy', 'Aheavywebp', 'image/webp')
  expect(await imageOf(row)).toEqual({ png: ONE_PX })
  await row.unmount()
  const converts = runs.filter(r => r.argv[0] === 'sips' && r.argv[1] === '-s').map(r => r.argv.includes('-Z') ? Number(r.argv[r.argv.indexOf('-Z') + 1]) : 0)
  expect(converts).toEqual([0, 750])
})

test('0.17.0: a picture an earlier load converted is read back, with no sips', { options: { screenshots: true } }, async ($, on) => {
  engineBody(on)
  conversation(on, [])
  const data = 'Bconvertedbefore'
  const { runs } = fakeDisk(on, { files: { [`${DIR}/${hashOf(data)}.png`]: 'B' } })
  await useRow($ as never, 'again', '/tmp/again.jpg')
  const row = await resultRow($ as never, 'again', data, 'image/jpeg')
  expect(await imageOf(row)).toEqual({ png: PNG_2PX })
  await row.unmount()
  expect(runs.filter(r => r.argv[0] === 'sips')).toHaveLength(0)
})

test('0.17.0: in the transcript view a grouped Read draws its picture once, under its ToolUse row', { options: { screenshots: true } }, async ($, on) => {
  engineBody(on)
  on('ui.render', { component: 'ToolGroup' }, (engine, e) => engine.ui.resolve(e).Text({ children: ['engine group'] }) as never)
  conversation(on, [])
  // the engine unfolded the group: its rows are glass's grouped rows
  const a = readCall('tv-a', '/tmp/a.png'), b = readCall('tv-b', '/tmp/b.png')
  const g = await $.ui.mount({ plugin: 'glass', surface: 'terminal', component: 'ToolGroup', props: { calls: [a, b], isActive: false, isExpanded: true } })
  await g.unmount()
  let images = 0
  const bodies: string[] = []
  for (const c of [a, b]) {
    const use = await $.ui.mount({ plugin: 'glass', surface: 'terminal', component: 'ToolUse', props: c })
    images += (await use.findAll({ type: 'Image' })).length
    await use.unmount()
    const result = await resultRow($ as never, c.tool_use_id)
    images += (await result.findAll({ type: 'Image' })).length
    if (await result.find({ type: 'Text', text: /engine body/ })) bodies.push(c.tool_use_id)
    await result.unmount()
  }
  // b, the group's chosen Read, draws once; a keeps the engine's row
  expect(images).toBe(1)
  expect(bodies).toEqual(['tv-a'])
})


test('0.17.0: conversions run one at a time; two rows asking together both draw', { options: { screenshots: true } }, async ($, on) => {
  engineBody(on)
  conversation(on, [])
  const { most } = fakeDisk(on, { slow: true })
  await useRow($ as never, 'q-1', '/tmp/q1.jpg')
  await useRow($ as never, 'q-2', '/tmp/q2.jpg')
  const [one, two] = await Promise.all([resultRow($ as never, 'q-1', 'Aqueue1', 'image/jpeg'), resultRow($ as never, 'q-2', 'Bqueue2', 'image/jpeg')])
  expect(await imageOf(one!)).toEqual({ png: ONE_PX })
  expect(await imageOf(two!)).toEqual({ png: PNG_2PX })
  await one!.unmount()
  await two!.unmount()
  expect(most()).toBe(1)
})

test('0.17.0: a conversion that never answers times out, frees the queue, and the next draw tries again', { options: { screenshots: true } }, async ($, on) => {
  engineBody(on)
  conversation(on, [])
  const clock = mock.clock(on, { now: 1_000_000 })
  let stuck = true
  fakeDisk(on, { stuck: () => stuck })
  await useRow($ as never, 'hang-1', '/tmp/hang.jpg')
  const first = resultRow($ as never, 'hang-1', 'Ahangjpeg', 'image/jpeg')
  await clock.advance(8000)
  const row = await first
  expect(await imageOf(row)).toBeUndefined()
  await row.unmount()
  stuck = false
  const again = await resultRow($ as never, 'hang-1', 'Ahangjpeg', 'image/jpeg')
  expect(await imageOf(again)).toEqual({ png: ONE_PX })
  await again.unmount()
})

// ---- 0.17.0: the second /rv's findings, one test each --------------------
test('0.17.0: a text Read never waits on the conversation; a picture Read waits on it at most 2 s', async ($, on) => {
  engineBody(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  let reads = 0
  // a conversation read that never answers
  on('session.messages', (() => {
    reads++
    return new Promise(() => {})
  }) as never)
  const text = await $.ui.mount({
    plugin: 'glass', surface: 'terminal', component: 'ToolResult',
    props: { tool_use_id: 'txt-1', tool: 'Read', isErrored: false, isExpanded: false, output: { type: 'text', file: { filePath: '/a.ts', content: 'x' } } },
  })
  expect(await text.find({ type: 'Text', text: /engine body/ })).toBeDefined()
  await text.unmount()
  expect(reads).toBe(0)
  // a picture Read: the engine's row after the cap, not a row that never draws
  const pending = resultRow($ as never, 'pic-wait', ONE_PX)
  // a second at a time: the draw's timer starts once its hook runs
  for (let i = 0; i < 3; i++) await clock.advance(1000)
  const row = await pending
  expect(await row.find({ type: 'Image' })).toBeUndefined()
  expect(await row.find({ type: 'Text', text: /engine body/ })).toBeDefined()
  await row.unmount()
  expect(reads).toBe(1)
})

test('0.17.0: a job waiting its turn gets its own 8 s: after one hangs, the next ones still draw', { options: { screenshots: true } }, async ($, on) => {
  engineBody(on)
  conversation(on, [])
  const clock = mock.clock(on, { now: 1_000_000 })
  let writes = 0
  // the first write never answers; the rest take 100 ms each
  fakeDisk(on, { stuck: () => ++writes === 1, delay: () => clock.sleep(100) })
  for (const id of ['wait-1', 'wait-2', 'wait-3']) await useRow($ as never, id, `/tmp/${id}.jpg`)
  const rows = [resultRow($ as never, 'wait-1', 'Ahang', 'image/jpeg'), resultRow($ as never, 'wait-2', 'Anext', 'image/jpeg'), resultRow($ as never, 'wait-3', 'Blast', 'image/jpeg')]
  // every job is queued before any time passes
  for (let i = 0; i < 5; i++) await clock.advance(1)
  // the hung job's 8 s, then a little: the next two run 100 ms each on their own budget
  for (let i = 0; i < 90; i++) await clock.advance(100)
  const [one, two, three] = await Promise.all(rows)
  expect(await imageOf(one!)).toBeUndefined()
  expect(await imageOf(two!)).toEqual({ png: ONE_PX })
  expect(await imageOf(three!)).toEqual({ png: PNG_2PX })
  for (const r of [one!, two!, three!]) await r.unmount()
})

test('0.17.0: each conversion run writes its own scratch files and removes them', { options: { screenshots: true } }, async ($, on) => {
  engineBody(on)
  conversation(on, [])
  const clock = mock.clock(on, { now: 1_000_000 })
  let writes = 0
  const { runs } = fakeDisk(on, { stuck: () => ++writes === 1 })
  await useRow($ as never, 'same-1', '/tmp/same.jpg')
  // the first run hangs past its 8 s; the next draw converts the same bytes again
  const first = resultRow($ as never, 'same-1', 'Asamebytes', 'image/jpeg')
  await clock.advance(8000)
  await (await first).unmount()
  const again = await resultRow($ as never, 'same-1', 'Asamebytes', 'image/jpeg')
  expect(await imageOf(again)).toEqual({ png: ONE_PX })
  await again.unmount()
  const sources = runs.filter(r => r.argv[0] === 'sh' && !/mkdir/.test(r.argv[2] ?? '')).map(r => r.argv[3])
  expect(sources).toHaveLength(2)
  expect(sources[0]).not.toBe(sources[1])
  // the retry's scratch files go once it is done
  expect(runs.some(r => r.argv[0] === 'rm' && r.argv.includes(sources[1]!))).toBe(true)
})

// ---- 0.17.0: the live long run's findings ---------------------------------
test('0.17.0: a file the person named counts however Claude spells its path', () => {
  const H = '/Users/me'
  // Claude reads the real path behind /tmp, and the full path of a bare name
  expect(namedIn(['Use the Read tool on /tmp/qa/pic-20.png.'], '/private/tmp/qa/pic-20.png', H)).toBe(true)
  expect(namedIn(['open /private/var/x/b.png'], '/var/x/b.png', H)).toBe(true)
  expect(namedIn(['Use the Read tool on pic-21.png in this folder.'], '/private/tmp/qa/pic-21.png', H)).toBe(true)
  expect(namedIn(['see `shots/a.png`', '(c(1).png)'], '/Users/me/p/shots/a.png', H)).toBe(true)
  expect(namedIn(['(c(1).png)'], '/p/c(1).png', H)).toBe(true)
  expect(namedIn(['look at a.png.'], '/p/a.png', H)).toBe(true)
  // a name inside another word, or with more after it, is another file
  expect(namedIn(['the file data.png is fine'], '/p/a.png', H)).toBe(false)
  expect(namedIn(['look at a.png.bak'], '/p/a.png', H)).toBe(false)
  expect(namedIn(['look at mya.png'], '/p/a.png', H)).toBe(false)
})

test('0.17.0: a group whose newest picture cannot draw shows an older one that can', { options: { screenshots: true } }, async ($, on) => {
  on('ui.render', { component: 'ToolGroup' }, (engine, e) => engine.ui.resolve(e).Text({ children: [e.props.isExpanded ? 'opened' : 'folded'] }) as never)
  conversation(on, [])
  // no sips: every conversion fails
  on('process.run', ((_: unknown, e: { argv: readonly string[] }) => {
    if (e.argv[0] === 'sh' && /mkdir/.test(e.argv[2] ?? '')) return { value: { exitCode: 0, stdout: DIR, stderr: '' } }
    if (e.argv[0] === 'sips') return { value: { exitCode: 127, stdout: '', stderr: 'sips: command not found' } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  }) as never)
  on('fs.stat', ((_: unknown, e: { path: string }) => ({ deny: `no such file: ${e.path}` })) as never)
  const png = readCall('mix-png', '/tmp/mix/16.png', PNG_2PX)
  const jpeg = readCall('mix-jpg', '/tmp/mix/15.jpg', 'A15jpeg', 'image/jpeg')
  const g = await $.ui.mount({ plugin: 'glass', surface: 'terminal', component: 'ToolGroup', props: { calls: [png, jpeg], isActive: false, isExpanded: false } })
  const images = await g.findAll({ type: 'Image' })
  expect(images).toHaveLength(1)
  expect((images[0] as { props?: { source?: unknown } }).props?.source).toEqual({ png: PNG_2PX })
  expect(await g.find({ type: 'Text', text: /opened/ })).toBeUndefined()
  await g.unmount()
})

test('0.17.0: an open group that picks its picture after the Read\'s row drew redraws that row with it', { options: { screenshots: true } }, async ($, on) => {
  on('ui.render', { component: 'ToolGroup' }, (engine, e) => engine.ui.resolve(e).Text({ children: ['engine group'] }) as never)
  conversation(on, [])
  const glob = { tool_use_id: 'late-g', tool: 'Glob', input: {}, isRunning: false, isErrored: true, isInterrupted: false, output: 'No such tool available: Glob' }
  const read = readCall('late-r', '/tmp/late/zeta.png')
  // the Read's row draws first, before the group has chosen anything
  const row = await $.ui.mount({ plugin: 'glass', surface: 'terminal', component: 'ToolUse', props: read })
  expect(await row.find({ type: 'Image' })).toBeUndefined()
  // the failed Glob opens the group, which now chooses the Read
  const g = await $.ui.mount({ plugin: 'glass', surface: 'terminal', component: 'ToolGroup', props: { calls: [glob, read], isActive: true, isExpanded: false } })
  await g.unmount()
  expect(await row.find({ type: 'Image' })).toBeDefined()
  await row.unmount()
})

test('0.17.1: off by default: a screenshot keeps the engine row and its group stays folded', async ($, on) => {
  on('ui.render', { component: 'ToolResult' }, (engine, e) => engine.ui.resolve(e).Text({ children: ['engine body'] }) as never)
  on('ui.render', { component: 'ToolGroup' }, (engine, e) => engine.ui.resolve(e).Text({ children: [e.props.isExpanded ? 'opened' : 'folded'] }) as never)
  conversation(on, [])
  const shot = { tool_use_id: 'off-s', tool: 'mcp__plugin_jev-reach_chrome-devtools__take_screenshot', input: {}, isRunning: false, isErrored: false, isInterrupted: false, output: engineResult(ONE_PX, 'image/png', null) }
  const row = await $.ui.mount({ plugin: 'glass', surface: 'terminal', component: 'ToolResult', props: { tool_use_id: 'off-s', tool: shot.tool, isErrored: false, isExpanded: false, output: shot.output } })
  expect(await row.find({ type: 'Image' })).toBeUndefined()
  expect(await row.find({ type: 'Text', text: /engine body/ })).toBeDefined()
  await row.unmount()
  const page = { tool_use_id: 'off-p', tool: 'mcp__plugin_jev-reach_chrome-devtools__new_page', input: {}, isRunning: false, isErrored: false, isInterrupted: false, output: [{ type: 'text', text: 'ok' }] }
  const g = await $.ui.mount({ plugin: 'glass', surface: 'terminal', component: 'ToolGroup', props: { calls: [page, shot, readCall('off-r', '/tmp/off.png')], isActive: false, isExpanded: false } })
  expect(await g.findAll({ type: 'Image' })).toHaveLength(0)
  expect(await g.find({ type: 'Text', text: /opened/ })).toBeUndefined()
  await g.unmount()
})
