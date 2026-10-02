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

test('before anything plays: the hint, and the eight keys', async $ => {
  const ui = await $.ui.mount({ plugin: 'cc-shorts', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'Run /shorts to start' })).toBeDefined()
  for (const label of ['Next', 'Prev', 'Pause', 'Replay', 'Like', 'Mute', 'Open', 'Close']) {
    expect(await ui.find({ type: 'Button', text: label })).toBeDefined()
  }
  await ui.unmount()
})

test('the author, and Open, open the Short in the browser', async ($, on) => {
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
  const opened = () => argvs.filter(argv => argv[0] === 'open')
  await ui.press({ key: 'author' })
  expect(opened()).toEqual([['open', 'https://www.youtube.com/shorts/abc123']])
  await ui.press({ key: 'open' })
  expect(opened()).toHaveLength(2)
  await ui.unmount()
})

test('replay plays the Short on screen again from the start', async ($, on) => {
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('fs.exists', () => ({ value: true }))
  // Where the watched ids go.
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  const spawned: (readonly string[])[] = []
  on('process.spawn', async function* (_, e) {
    spawned.push(e.argv)
    return { value: { code: 1, signal: null } }
  })
  // The ticker would read frames: held still.
  mock.clock(on)
  // Paused 12 s into the second of two Shorts, both downloaded.
  const one = { id: 'one', title: 'One', author: 'Someone', duration: 30, hasAudio: true, path: '/tmp/one.mp4' }
  const two = { ...one, id: 'two', title: 'Two', path: '/tmp/two.mp4' }
  let value: unknown = { ...EMPTY, queue: ['one', 'two'], cur: 1, shorts: { one, two }, status: 'paused', pos: 12 }
  let version = 1
  on('state.get', () => ({ value: { value, version } }))
  on('state.set', (_, e) => {
    if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } }
    value = e.value
    return { value: { isSet: true, version: ++version } }
  })
  const ui = await $.ui.mount({ plugin: 'cc-shorts', surface: 'terminal', ...PANE })
  await ui.press({ key: 'replay' })
  const ffmpeg = spawned.find(argv => argv[0] === 'ffmpeg') ?? []
  expect(ffmpeg[ffmpeg.indexOf('-ss') + 1]).toBe('0.00')
  expect(ffmpeg[ffmpeg.indexOf('-i') + 1]).toBe('/tmp/two.mp4')
  expect(value).toEqual(expect.objectContaining({ cur: 1 }))
  await ui.unmount()
})

test('the Short to play downloads first, and skipped or closed ones never do', async ($, on) => {
  const clock = mock.clock(on)
  // Each download takes a second of the mocked clock, so the test says when it ends.
  const started: string[] = []
  on('process.run', async (_, e) => {
    const at = e.argv.indexOf('download')
    let stdout = ''
    if (at >= 0) {
      const id = e.argv[at + 1] ?? ''
      started.push(id)
      await clock.sleep(1000)
      stdout = JSON.stringify({
        id,
        title: id,
        author: 'Someone',
        duration: 30,
        hasAudio: true,
        path: `/tmp/${id}.mp4`,
      })
    }
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* () {
    return { value: { code: 1, signal: null } }
  })
  mock.store(on)
  on('ui.toast', () => ({ value: undefined }))
  on('ui.close', () => ({ value: undefined }))
  // A dozen queued, so the queue needs no refill; none downloaded yet.
  const queue = 'abcdefghijkl'.split('')
  let value: unknown = { ...EMPTY, queue }
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
  const ui = await $.ui.mount({ plugin: 'cc-shorts', surface: 'terminal', ...PANE })

  await ui.press({ key: 'next' })
  expect(started).toEqual(['b'])
  // b is in: c starts, and d to g wait behind it.
  await clock.advance(1000)
  expect(started).toEqual(['b', 'c'])
  // On to f while c is still coming: f goes ahead of d and e.
  for (let i = 0; i < 4; i++) await ui.press({ key: 'next' })
  expect(value).toEqual(expect.objectContaining({ cur: 5 }))
  await clock.advance(1000)
  expect(started).toEqual(['b', 'c', 'f'])
  // f is in: g goes next, as d and e were dropped once skipped past.
  await clock.advance(1000)
  expect(started).toEqual(['b', 'c', 'f', 'g'])

  // Closed while g is coming: nothing that waited starts after it.
  await ui.press({ key: 'close' })
  await clock.advance(5000)
  expect(started).toEqual(['b', 'c', 'f', 'g'])
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
