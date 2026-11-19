// 0.5.0: every palette has a theme, built from one fixed table; the forward
// slot names glass draws with are the engine's own.
import { expect, test } from 'claude-code/testing'

import { PALETTES } from '../hooks/palette'
import type { PaletteName } from '../hooks/palette'
import { THEME, contrast, deepen, groundHex, grounded, lift, scale, stepFactor, themeFileName, themeFor, themeJson, themeSetting } from '../hooks/theme'

// 0.20.0: the `ground` option. The palette's own ground tints, dimmed or
// brightened together so the card stands its step off the person's ground.
test('a ground reads as a hex with or without the hash, three digits or six; anything else is no ground', async () => {
  expect(groundHex('#0B1029')).toBe('#0b1029')
  expect(groundHex(' 0b1029 ')).toBe('#0b1029')
  expect(groundHex('#fff')).toBe('#ffffff')
  for (const v of ['', 'navy', '#0b102', '#0b1029ff', 'rgb(1,2,3)', undefined, 7]) expect(groundHex(v)).toBe(null)
})

test('on a darker ground the night-owl card is the same teal, darker: the old hex stood too far off', async () => {
  const rex = '#06101a'
  expect(contrast('#0e2a3a', rex)).toBeGreaterThan(1.28)
  const k = stepFactor('#0e2a3a', rex)
  expect(k).toBeLessThan(1)
  const card = scale('#0e2a3a', k)
  expect(Math.abs(contrast(card, rex) - 1.16)).toBeLessThan(0.02)
  // the hue is kept: blue over green over red, as in the palette's own tint
  const ch = (i: number) => parseInt(card.slice(1 + 2 * i, 3 + 2 * i), 16)
  expect(ch(2)).toBeGreaterThan(ch(1))
  expect(ch(1)).toBeGreaterThan(ch(0))
})

test('a grounded palette puts its card one step off any ground, on the far side from it', async () => {
  for (const name of NAMES) {
    const p = PALETTES[name]
    for (const g of ['#000000', '#011627', '#06101a', '#0a1f30', '#1e1e2e', '#282c34']) {
      const card = grounded(p, g).blockBg
      expect(Math.abs(contrast(card, g) - 1.16)).toBeLessThan(0.03)
      expect(contrast(card, '#ffffff')).toBeLessThan(contrast(g, '#ffffff'))
    }
    for (const g of ['#ffffff', '#fafafa', '#eff1f5', '#fdf6e3']) {
      const card = grounded(p, g).blockBg
      expect(Math.abs(contrast(card, g) - 1.13)).toBeLessThan(0.03)
      expect(contrast(card, '#000000')).toBeLessThan(contrast(g, '#000000'))
    }
  }
})

test('a grounded palette changes its four ground tints alone, by one factor, and no ground changes nothing', async () => {
  for (const name of NAMES) {
    const p = PALETTES[name]
    expect(grounded(p, '')).toBe(p)
    expect(grounded(p, 'navy')).toBe(p)
    const g = grounded(p, '#06101a')
    const k = stepFactor(p.blockBg, '#06101a')
    const tints = ['blockBg', 'rowHover', 'addBg', 'delBg'] as const
    for (const role of tints) expect(g[role]).toBe(scale(p[role], k))
    // tints the palette holds equal stay equal
    if (p.rowHover === p.blockBg) expect(g.rowHover).toBe(g.blockBg)
    if (p.addBg === p.blockBg) expect(g.addBg).toBe(g.blockBg)
    for (const role of Object.keys(p) as (keyof typeof p)[]) {
      if (!(tints as readonly string[]).includes(role)) expect(g[role]).toBe(p[role])
    }
    // the theme file carries the derived tint to the rows the engine paints
    expect(themeFor(g, name).overrides.userMessageBackground).toBe(g.blockBg)
    expect(themeFor(g, name).overrides.bashMessageBackgroundColor).toBe(g.blockBg)
    expect(themeFor(g, name).overrides.diffRemoved).toBe(g.delBg)
  }
})

const NAMES: PaletteName[] = ['tidepool', 'tarnish', 'overprint', 'ironbow', 'lagoon', 'iris', 'tangerine', 'prism', 'prism-light', 'tangerine-light', 'water', 'crimson', 'codex']
const REQUIRED = [
  'success', 'error', 'warning', 'claude', 'permission', 'planMode', 'autoAccept',
  'promptBorder', 'bashBorder', 'secondaryBorder', 'secondaryText', 'inactive', 'subtle', 'suggestion',
  'userMessageBackground', 'bashMessageBackgroundColor', 'userMessageBackgroundHover', 'thinking',
  'diffAdded', 'diffRemoved', 'diffAddedDimmed', 'diffRemovedDimmed', 'diffAddedWord', 'diffRemovedWord',
]

test('every palette yields a theme: its ground as the base, every slot in the table, every value a six-digit hex', async () => {
  for (const name of NAMES) {
    const theme = themeFor(PALETTES[name], name)
    expect(theme.name).toBe(`glass-${name}`)
    expect(theme.base).toBe(PALETTES[name].ground ?? 'dark')
    for (const slot of REQUIRED) expect(typeof theme.overrides[slot]).toBe('string')
    for (const v of Object.values(theme.overrides)) expect(/^#[0-9a-f]{6}$/.test(v)).toBe(true)
    // the slots glass reads forward resolve to the palette's own colors under its theme
    expect(theme.overrides.diffAdded).toBe(PALETTES[name].addBg.toLowerCase())
    expect(theme.overrides.diffRemoved).toBe(PALETTES[name].delBg.toLowerCase())
    // the word slots are the engine's word backgrounds: the row tint a step from the ground, not a text color (0.5.3, 0.16.0)
    const step = PALETTES[name].ground === 'light' ? deepen : lift
    expect(theme.overrides.diffAddedWord).toBe(step(PALETTES[name].addBg).toLowerCase())
    expect(theme.overrides.diffRemovedWord).toBe(step(PALETTES[name].delBg).toLowerCase())
    expect(theme.overrides.success).toBe(PALETTES[name].ok.toLowerCase())
    expect(theme.overrides.error).toBe(PALETTES[name].err.toLowerCase())
    // the engine's own autoAccept is a green, so it takes `ok`, apart from `warning`
    expect(theme.overrides.autoAccept).toBe(PALETTES[name].ok.toLowerCase())
    expect(theme.overrides.autoAccept).not.toBe(theme.overrides.warning)
    expect(theme.overrides.warning).toBe(PALETTES[name].warn.toLowerCase())
    expect(theme.overrides.permission).toBe(PALETTES[name].tool.toLowerCase())
    // 0.10.1: the prompt border is the person's color, bash mode the verb's, never the grey rule
    expect(theme.overrides.promptBorder).toBe((PALETTES[name].promptBorder ?? PALETTES[name].accentUser).toLowerCase())
    expect(theme.overrides.bashBorder).toBe(PALETTES[name].cmd.toLowerCase())
    expect(theme.overrides.promptBorder).not.toBe(PALETTES[name].rule.toLowerCase())
  }
})

test('the file and setting names, and the JSON round-trips', async () => {
  expect(themeFileName('water')).toBe('glass-water.json')
  expect(themeSetting('water')).toBe('custom:glass-water')
  const theme = themeFor(PALETTES.tidepool, 'tidepool')
  const text = themeJson(theme)
  expect(text.endsWith('\n')).toBe(true)
  expect(JSON.parse(text)).toEqual(theme)
})

test('the forward slot names are the engine keys, spelled exactly', async () => {
  expect(THEME).toEqual({
    success: 'success',
    error: 'error',
    planMode: 'planMode',
    autoAccept: 'autoAccept',
    warning: 'warning',
    diffAdded: 'diffAdded',
    diffRemoved: 'diffRemoved',
    diffAddedWord: 'diffAddedWord',
    diffRemovedWord: 'diffRemovedWord',
  })
})

test('0.14.0: a palette may set its own prompt border; prism takes the band purple, its row stays coral', async () => {
  const theme = themeFor(PALETTES.prism, 'prism')
  expect(theme.overrides.promptBorder).toBe(PALETTES.prism.accent.toLowerCase())
  expect(theme.overrides.promptBorder).not.toBe(PALETTES.prism.accentUser.toLowerCase())
  // a palette that leaves it out keeps the person's color
  expect(themeFor(PALETTES.tarnish, 'tarnish').overrides.promptBorder).toBe(PALETTES.tarnish.accentUser.toLowerCase())
})

test('0.16.0: the light pair takes the light base and word tints darker than its rows', async () => {
  const lum = (hex: string) => [1, 3, 5].reduce((n, i) => n + parseInt(hex.slice(i, i + 2), 16), 0)
  for (const name of ['prism-light', 'tangerine-light'] as const) {
    const theme = themeFor(PALETTES[name], name)
    expect(theme.base).toBe('light')
    expect(lum(theme.overrides.diffAddedWord!)).toBeLessThan(lum(theme.overrides.diffAdded!))
    expect(lum(theme.overrides.diffRemovedWord!)).toBeLessThan(lum(theme.overrides.diffRemoved!))
  }
  // a dark palette's word tints stay lifted
  const dark = themeFor(PALETTES.prism, 'prism')
  expect(dark.base).toBe('dark')
  expect(lum(dark.overrides.diffAddedWord!)).toBeGreaterThan(lum(dark.overrides.diffAdded!))
})
