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

/** `/shorts` as the person types it. */
const SHORTS = {
  command: 'shorts',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

/** What a run of `argv` answers, as `process.run` resolves it. */
const ran = (exitCode: number, stdout = '') => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

test('missing yt-dlp and ffmpeg: the session says so, and /shorts offers to have Claude install them', async ($, on) => {
  on('process.run', (_, e) => {
    const [exe, arg] = e.argv
    if (exe === 'ffmpeg') throw new Error('spawn ffmpeg ENOENT')
    if (exe === 'which') return ran(arg === 'brew' ? 0 : 1)
    // No Python that imports yt_dlp; deno and the rest are there.
    return ran(e.argv.includes('import yt_dlp') ? 1 : 0)
  })
  on('fs.exists', () => ({ value: true }))
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const questions: string[] = []
  let answer = 'Ask Claude to install'
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const question = e.questions[0]?.question ?? ''
    questions.push(question)
    return { result: { questions: e.questions, answers: { [question]: answer } } }
  })
  const submitted: { text: string; asUser?: boolean }[] = []
  on('prompt.submit', (_, e) => {
    submitted.push({ text: e.text, asUser: e.origin.kind === 'plugin' ? e.origin.asUser : undefined })
    return { text: e.text }
  })
  const opened: string[] = []
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  const { settle } = mock.clock(on)
  mock.env(on, { HOME: '/Users/someone', TMPDIR: '/tmp' })
  on('session.id', () => ({ value: 'a-session' }))
  on('command.register', () => ({ value: { command: 'shorts' } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await settle()
  expect(toasts).toEqual(['cc-shorts: yt-dlp and ffmpeg are missing; /shorts offers to install them'])

  await $.command.run(SHORTS)
  await settle()
  expect(opened).toEqual([])
  expect(questions).toHaveLength(1)
  expect(questions[0]).toContain('`brew install yt-dlp ffmpeg`')
  expect(submitted).toHaveLength(1)
  expect(submitted[0]?.asUser).toBe(true)
  expect(submitted[0]?.text).toContain('- ffmpeg: not found')
  expect(submitted[0]?.text).toContain('Run `brew install yt-dlp ffmpeg`')

  // Not now: nothing for Claude, and still no pane.
  answer = 'Not now'
  await $.command.run(SHORTS)
  await settle()
  expect(questions).toHaveLength(2)
  expect(submitted).toHaveLength(1)
  expect(opened).toEqual([])
})

test('everything there: /shorts asks for the browser once, and the helpers read its cookies', async ($, on) => {
  const PYTHON = '/opt/homebrew/Cellar/yt-dlp/2026.8.19/libexec/bin/python'
  const helperCalls: { argv: readonly string[]; browser?: string }[] = []
  let feedError = ''
  on('process.run', (_, e) => {
    const [exe, ...args] = e.argv
    if (exe === 'which') return ran(0, '/opt/homebrew/bin/yt-dlp\n')
    if (exe === 'head') return ran(0, `#!${PYTHON}\n`)
    if (exe === 'ffmpeg') return ran(0, ' E audiotoolbox    AudioToolbox output device\n')
    if (args.includes('import yt_dlp')) return ran(exe === PYTHON ? 0 : 1)
    if (!e.argv.some(arg => arg.endsWith('/helper/yt.py'))) return ran(0)
    helperCalls.push({ argv: e.argv, browser: e.init?.env?.CC_SHORTS_BROWSER })
    if (feedError !== '') return { value: { ...ran(1).value, stderr: `${feedError}\n` } }
    return ran(0, JSON.stringify({ ids: [], token: null, source: 'home', loggedIn: true }))
  })
  // Chrome, Edge and Firefox used here; Safari is on every Mac.
  const used = ['Google/Chrome', 'Microsoft Edge', 'Firefox/Profiles']
  on('fs.exists', (_, e) => ({ value: used.some(dir => e.path.endsWith(`/Library/Application Support/${dir}`)) }))
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const asked: { question: string; options: string[] }[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const q = e.questions[0]
    asked.push({ question: q?.question ?? '', options: (q?.options ?? []).map(o => o.label) })
    return { result: { questions: e.questions, answers: { [q?.question ?? '']: 'Firefox' } } }
  })
  const opened: string[] = []
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  let value: unknown = EMPTY
  let version = 1
  on('state.get', () => ({ value: { value, version } }))
  on('state.set', (_, e) => {
    if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } }
    value = e.value
    return { value: { isSet: true, version: ++version } }
  })
  // Scrolled with Chrome's login before there was a choice.
  const store: Record<string, unknown> = { token: 'from-chrome' }
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    delete store[e.key]
    return { value: undefined }
  })
  const { settle } = mock.clock(on)
  mock.env(on, { HOME: '/Users/someone', TMPDIR: '/tmp' })
  on('session.id', () => ({ value: 'a-session' }))
  on('command.register', () => ({ value: { command: 'shorts' } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await settle()
  expect(toasts).toEqual([])

  await $.command.run(SHORTS)
  await settle()
  expect(asked).toEqual([
    { question: expect.stringContaining('Which browser'), options: ['Chrome', 'Safari', 'Edge', 'Firefox'] },
  ])
  expect(store.browser).toBe('firefox')
  // Chrome's place in the feed is no use to Firefox's account.
  expect(store.token).toBeUndefined()
  expect(opened).toEqual(['shorts'])
  expect(helperCalls[0]?.argv[0]).toBe(PYTHON)
  expect(helperCalls[0]?.argv).toContain('feed')
  expect(helperCalls[0]?.browser).toBe('firefox')

  // Chosen once: the next /shorts asks nothing, and a failed feed says why.
  feedError = "signed out: no YouTube login in firefox's cookies"
  await $.command.run(SHORTS)
  await settle()
  expect(asked).toHaveLength(1)
  expect(value).toEqual(expect.objectContaining({ status: 'error', message: expect.stringContaining(feedError) }))
  expect(value).toEqual(expect.objectContaining({ message: expect.stringContaining('/shorts browser') }))

  // `/shorts browser` asks again, the browser in use first.
  await $.command.run({ ...SHORTS, args: 'browser' })
  await settle()
  expect(asked[1]?.options).toEqual(['Firefox', 'Chrome', 'Safari', 'Edge'])
})
