import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'shorts',
  props: {
    title: 'Shorts',
    isFocused: true,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const EMPTY = { queue: [], cur: 0, shorts: {}, status: 'idle', message: '', pos: 0, muted: false, isLoggedIn: true }

test('before anything plays: the hint, and the six keys', async $ => {
  const ui = await $.ui.mount({ plugin: 'cc-shorts', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'Run /shorts to start' })).toBeDefined()
  for (const label of ['Prev', 'Next', 'Pause', 'Like', 'Mute', 'Close']) {
    expect(await ui.find({ type: 'Button', text: label })).toBeDefined()
  }
  await ui.unmount()
})

test('the author opens the Short in the browser', async ($, on) => {
  const argvs: (readonly string[])[] = []
  on('process.run', (_, e) => {
    argvs.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // One Short queued and idle: the plugin's only state value, read from here.
  const short = { id: 'abc123', title: 'A title', author: 'Someone', duration: 30, hasAudio: true }
  const value = { ...EMPTY, queue: [short.id], shorts: { [short.id]: short } }
  on('state.get', () => ({ value: { value, version: 1 } }))
  const ui = await $.ui.mount({ plugin: 'cc-shorts', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Button', text: 'Someone ↗' })).toBeDefined()
  await ui.press({ key: 'author' })
  expect(argvs).toContainEqual(['open', 'https://www.youtube.com/shorts/abc123'])
  await ui.unmount()
})

test('likes: shown at once, put back when refused, every press counted', async ($, on) => {
  const argvs: (readonly string[])[] = []
  let exitCode = 0
  on('process.run', (_, e) => {
    argvs.push(e.argv)
    const stdout = exitCode === 0 ? '{"id": "abc123"}' : ''
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const short = { id: 'abc123', title: 'A title', author: 'Someone', duration: 30, hasAudio: true }
  // The plugin's only state value, held here so its writes come back.
  let value: unknown = { ...EMPTY, queue: [short.id], shorts: { [short.id]: short } }
  let version = 1
  on('state.get', () => ({ value: { value, version } }))
  on('state.set', (_, e) => {
    if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } }
    value = e.value
    return { value: { isSet: true, version: ++version } }
  })
  // What `session.start` asks of the session, for the helper's path.
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/Users/someone' : undefined }))
  on('session.id', () => ({ value: 'a-session' }))
  on('command.register', () => ({ value: { command: 'shorts' } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const yt = (cmd: string) => argvs.filter(argv => argv.includes(cmd) && argv.includes(short.id))
  // The state above redraws nothing when written: each press draws anew.
  const press = async (key: string, times = 1) => {
    const pressed = await $.ui.mount({ plugin: 'cc-shorts', surface: 'terminal', ...PANE })
    await Promise.all(Array.from({ length: times }, () => pressed.press({ key })))
    await pressed.unmount()
    return $.ui.mount({ plugin: 'cc-shorts', surface: 'terminal', ...PANE })
  }

  let ui = await press('like')
  expect(await ui.find({ type: 'Button', text: 'Unlike' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\bLiked\b/ })).toBeDefined()
  expect(yt('like')).toHaveLength(1)
  await ui.unmount()

  exitCode = 1
  ui = await press('like')
  expect(yt('unlike')).toHaveLength(1)
  // The unlike failed: the like stands, as it does on YouTube.
  expect(await ui.find({ type: 'Button', text: 'Unlike' })).toBeDefined()
  await ui.unmount()

  // Two presses landing together: unliked, then liked again, and YouTube
  // told the last of them.
  exitCode = 0
  ui = await press('like', 2)
  expect(await ui.find({ type: 'Button', text: 'Unlike' })).toBeDefined()
  expect(argvs.at(-1)?.at(-2)).toBe('like')
  await ui.unmount()
})

test('what plays outlives a /clear', async ($, on) => {
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('classic.SessionStart', () => ({}))
  const ui = await $.ui.mount({ plugin: 'cc-shorts', surface: 'terminal', ...PANE })
  const isMuted = async () => (await ui.find({ type: 'Button', text: 'Unmute' })) !== undefined
  await ui.press({ key: 'mute' })
  await $.session.end({ reason: 'clear', sessionId: 'before-clear', resume: { id: 'before-clear' } })
  // The host empties `$.state` here; a change after the snapshot stands in for that.
  await ui.press({ key: 'mute' })
  expect(await isMuted()).toBe(false)
  await $.classic.SessionStart({ source: 'clear' })
  expect(await isMuted()).toBe(true)
  // Put back once only.
  await ui.press({ key: 'mute' })
  await $.classic.SessionStart({ source: 'clear' })
  expect(await isMuted()).toBe(false)
  await ui.unmount()
})

test('an input method is kept off the hotkeys while the pane holds the keyboard', async ($, on) => {
  const PINYIN = 'com.apple.inputmethod.SCIM.ITABC'
  let was: string | null = PINYIN
  const imeCalls: (readonly string[])[] = []
  on('process.run', (_, e) => {
    const at = e.argv.findIndex(arg => arg.endsWith('/helper/ime.py'))
    if (at >= 0) imeCalls.push(e.argv.slice(at + 1))
    const stdout = e.argv.includes('english') ? JSON.stringify({ was }) : '{}'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const draw = (isFocused: boolean) =>
    $.ui.mount({ plugin: 'cc-shorts', surface: 'terminal', ...PANE, props: { ...PANE.props, isFocused } })
  // The switch runs on after the draw returns, unawaited.
  const { settle } = mock.clock(on)
  // Paused on one Short: an idle pane is one closing, and holds no keyboard.
  const short = { id: 'abc123', title: 'A title', author: 'Someone', duration: 30, hasAudio: true }
  let value: unknown = { ...EMPTY, queue: [short.id], shorts: { [short.id]: short }, status: 'paused' }
  let version = 1
  on('state.get', () => ({ value: { value, version } }))
  on('state.set', (_, e) => {
    if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } }
    value = e.value
    return { value: { isSet: true, version: ++version } }
  })
  // What `session.start` asks of the session, for the helper's path; the
  // pane is up, so nothing is shut down.
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/Users/someone' : undefined }))
  on('session.id', () => ({ value: 'a-session' }))
  on('command.register', () => ({ value: { command: 'shorts' } }))
  const pane = { id: 'shorts', title: 'Shorts', isShown: true, isFocused: true, isPlaced: true }
  on('ui.panes', () => ({ value: [pane] }))
  on('ui.close', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  let ui = await draw(true)
  await settle()
  await ui.unmount()
  // Drawn again with the keyboard still held: no second switch.
  ui = await draw(true)
  await ui.unmount()
  ui = await draw(false)
  await settle()
  await ui.unmount()
  expect(imeCalls).toEqual([['english'], ['select', PINYIN]])

  // English already: nothing switched, so nothing to put back.
  was = null
  ui = await draw(true)
  await settle()
  await ui.unmount()
  ui = await draw(false)
  await settle()
  await ui.unmount()
  expect(imeCalls).toHaveLength(3)

  // Closed while it holds the keyboard: no draw sees it go, the close gives it back.
  was = PINYIN
  ui = await draw(true)
  await settle()
  await ui.press({ key: 'close' })
  await ui.unmount()
  expect(imeCalls.slice(3)).toEqual([['english'], ['select', PINYIN]])
})

test('off the terminal it says so instead of drawing a player', async $ => {
  const ui = await $.ui.mount({ plugin: 'cc-shorts', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /only in the terminal/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  await ui.unmount()
})
