import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  HookStream,
  ImageSource,
  ProcessSpawnChunk,
  ProcessSpawnResult,
  Register,
  Timer,
} from 'claude-code'

import type { Frame, Mode, Short, Shorts } from '../types'
import {
  BROWSERS,
  blankCells,
  browserOptions,
  browserQuestion,
  clockTime,
  ffmpegArgs,
  findBrowser,
  frameSize,
  installPrompt,
  installQuestion,
  lastLine,
  nameList,
  parseProgress,
  setupToast,
  shebangPython,
  toCells,
  videoBox,
} from './lib'
import type { Box, Missing } from './lib'

const PANE = 'shorts'
const VIDEO = 'video'
/** The widest key the pane draws (`r: Replay`, `o: Open ↗`), and the space between keys. */
const KEY_COLUMNS = 9
const KEY_GAP = 2
/** The answer to the setup question that hands the install to Claude. */
const INSTALL = 'Ask Claude to install'
/** A Short counts as watched (and goes to the account's history) after this. */
const WATCHED_SECONDS = 10
/** How many watched ids `$.store` keeps, so the feed skips them. */
const SEEN_KEPT = 1000
/** Videos kept downloaded ahead of the one playing. */
const PRELOAD = 5
/** Refill the queue when this few are left after the one playing. */
const LOW_WATER = 5

const EMPTY: Shorts = {
  queue: [],
  cur: 0,
  shorts: {},
  status: 'idle',
  message: '',
  pos: 0,
  muted: false,
  isLoggedIn: true,
}
const shorts = atom({ plugin: 'cc-shorts', key: 'shorts' } as const, EMPTY)

type Player = {
  id: string
  stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  mode: Mode
  frame: Frame
  /** Where this ffmpeg started, and where it is now, in seconds. */
  start: number
  pos: number
  stderr: string
}

// What lives only as long as this load of the module: a hot reload kills the
// ffmpeg and cancels the timers with it, and `session.start` picks up again
// from `shorts`, which the host keeps.
let dir = ''
/** The box the pane last drew the picture in, from the render hook. */
let layout: Box | undefined
/** What the picture shows now, so a redraw draws the same. */
let lastSource: ImageSource | undefined
let lastCells: string | undefined
/** What `shorts` held when a /clear began, for the session after it. */
let carried: Shorts | undefined
/** The Python that runs `helper/`, one that has yt_dlp; '' until the setup check finds it. */
let python = ''
/** The last setup check, which names `python`: a helper waits for it. */
let checking: Promise<Missing[]> | undefined
/** True once a check found everything `/shorts` needs; until then each `/shorts` checks again. */
let isSetUp = false
/**
 * yt-dlp's name for the browser whose cookies the helpers read, as the person
 * chose it (kept in `$.store`); '' until they do, and `yt.py` reads Chrome's.
 */
let browser = ''
/** Bumped by every action that changes what plays; stale work checks it. */
let epoch = 0
let player: Player | undefined
let ticker: Timer | undefined
/** Downloads failed in a row: past a few, the network is down, not the video. */
let failures = 0
/**
 * Frame files are counted per load, so the load's start goes in their names
 * too: a reload counts from 1 again, and ffmpeg will not write over a file
 * the last load left behind.
 */
const loadMark = Date.now().toString(36)
let frameSeq = 0
let isBlitting = false
let generation = 0
let lastDeny = ''
const marked = new Set<string>()
let refilling: Promise<string | undefined> | undefined
/** Downloads not started yet, in the order they start (`download`). */
const waiting: { id: string; start: () => Promise<void>; drop: () => void }[] = []
let isDownloading = false
const downloads = new Map<string, Promise<Short | undefined>>()
/** Whether the pane held the keyboard at its last draw: each change acts once. */
let hadKeys = false
let keysChain: Promise<unknown> = Promise.resolve()
let likeChain: Promise<unknown> = Promise.resolve()

const log = ($: EngineInterface, text: string) => $.ui.log(text, { to: 'debug' })
const setShorts = ($: EngineInterface, change: (s: Shorts) => Shorts) => update($, shorts, change)
/** `setShorts` for the play begun at `my`: after a newer action, even a retried write leaves the state alone. */
const setShortsAt = ($: EngineInterface, my: number, change: (s: Shorts) => Shorts) =>
  setShorts($, s => (my === epoch ? change(s) : s))

type HelperReply<T> = { value: T; error?: undefined } | { value?: undefined; error: string }

/** Runs a script of `helper/` and parses the JSON it prints, or says why it could not; never rejects. */
async function runHelper<T>(
  $: EngineInterface,
  script: 'yt.py' | 'ime.py',
  args: string[],
  stdin: string | undefined,
  timeoutMs: number,
): Promise<HelperReply<T>> {
  let error: string
  try {
    await checking
    const env = browser === '' ? undefined : { CC_SHORTS_BROWSER: browser }
    const argv = [python, '-B', `${$.plugin.root}/helper/${script}`, ...args]
    const run = await $.process.run(argv, { stdin, timeoutMs, env })
    if (run.exitCode === 0) return { value: JSON.parse(lastLine(run.stdout)) as T }
    error = lastLine(run.stderr) || `exit ${run.exitCode}`
  } catch (err) {
    error = String(err)
  }
  log($, `${script} ${args[0]} failed: ${error}`)
  return { error }
}

/** What `runHelper` parsed; undefined on failure. */
async function helper<T>(
  $: EngineInterface,
  script: 'yt.py' | 'ime.py',
  args: string[],
  stdin: string | undefined,
  timeoutMs: number,
): Promise<T | undefined> {
  return (await runHelper<T>($, script, args, stdin, timeoutMs)).value
}

// --- the hooks ---------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')
    // A /clear keeps the folder of the session before it, and says so in
    // `shorts` for a reload after it to find.
    dir = (await read($, shorts)).dir ?? `${tmp}/cc-shorts/${await $.session.id()}`
    const chosen = await $.store.get('browser').catch(() => undefined)
    browser = typeof chosen === 'string' ? chosen : ''
    // Unawaited: the first prompt waits for this hook, and a helper waits for the check.
    const check = checkSetup($)
    void check.then(missing => {
      const toast = setupToast(missing)
      if (toast !== undefined) $.ui.toast(toast, { timeoutMs: 10_000 })
    })
    await $.command.register({
      name: 'shorts',
      description: 'Scroll your YouTube Shorts feed in a side pane',
      argumentHint: '[browser]',
    })
    // Downloads of sessions that ended without cleaning up (a crash).
    // prettier-ignore
    void $.process.run([
      'find', `${tmp}/cc-shorts`, '-mindepth', '1', '-maxdepth', '1', '-type', 'd', '-mtime', '+1',
      '-exec', 'rm', '-rf', '{}', '+',
    ])
    // After a hot reload: the pane may still be up, its ffmpeg gone.
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    const s = await read($, shorts)
    // A source still kept means the last load switched it and never gave it back.
    // No draw comes to a closed pane: it goes back once the check has named
    // the helper's Python.
    hadKeys = s.inputSource !== undefined
    if (!isOpen) void check.then(() => holdKeys($, false))
    if (isOpen && (s.status === 'playing' || s.status === 'loading')) void play($, s.pos)
    else if (isOpen && s.status === 'paused' && s.mode === 'raster' && s.frame) {
      // The cells on screen went with the old module; the paused frame's
      // file is still there to draw them again.
      void frameCells($, s.frame).then(
        cells => {
          lastCells = cells
          $.ui.invalidate('ui.render')
        },
        () => undefined,
      )
    } else if (!isOpen && s.status !== 'idle') await shutDown($)
    return started
  })

  on('command.run', { command: 'shorts' }, async ($, e) => {
    // Checked again until it passes: the person may have installed something since.
    if (!isSetUp) {
      const missing = await checkSetup($)
      if (missing.some(m => !m.isOptional)) {
        void offerInstall($, missing)
        return {}
      }
    }
    // The first time, and on `/shorts browser`: whose cookies the feed comes through.
    if ((browser === '' || e.args.trim() === 'browser') && !(await chooseBrowser($))) return {}
    await $.ui.open({ id: PANE, title: 'Shorts', focus: true, columns: 50, rows: 40 })
    const s = await read($, shorts)
    if (s.status === 'idle' || s.status === 'error') void play($, s.pos)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>Run Claude Code in a terminal to play Shorts.</Text>
    }
    const { Box, Text, Button, Image, Raster } = $.ui.resolve(e)
    const s = await read($, shorts)
    // The draw is the first to see the keyboard come or go (the person's
    // ctrl+x tab, a click, Esc); the switch runs on after it returns. Idle is
    // a pane closing (`shutDown`), whose last draws still hold the keyboard.
    void holdKeys($, e.props.isFocused && s.status !== 'idle')
    layout = videoBox(e.props.bodyColumns, e.props.scroll.bodyRows)
    const short = s.shorts[s.queue[s.cur] ?? '']
    const f = s.frame
    const hasPicture = f !== undefined && (s.status === 'playing' || s.status === 'paused')

    let picture
    if (hasPicture && s.mode === 'raster') {
      picture = (
        <Raster key={VIDEO} columns={f.columns} rows={f.rows} cells={lastCells ?? blankCells(f.columns, f.rows)} />
      )
    } else if (hasPicture) {
      const source = lastSource ?? { file: f.file, format: 'rgb' as const, width: f.width, height: f.height }
      picture = <Image key={VIDEO} source={source} columns={f.columns} rows={f.rows} alt={short?.title || ' '} />
    } else {
      picture = (
        <Box width={layout.columns} height={layout.rows} alignItems="center" justifyContent="center">
          <Text dimColor wrap="wrap">
            {s.message || 'Run /shorts to start'}
          </Text>
        </Box>
      )
    }

    const isLiked = short !== undefined && hasLike(s, short.id)
    const where = `${clockTime(s.pos)} / ${clockTime(short?.duration ?? 0)}`
    const state = s.status === 'paused' ? `⏸ ${where}` : s.status === 'playing' ? `▶ ${where}` : ''
    const notes = [
      state,
      isLiked ? 'Liked' : '',
      s.muted ? 'Muted' : '',
      s.isLoggedIn ? '' : 'Signed out: /shorts browser to switch',
    ]
      .filter(Boolean)
      .join(' · ')
    // Each key in a cell as wide as the widest, so the two rows' columns line
    // up and a label that changes (Pause to Play) moves nothing.
    const cell = (key: string, hotkey: string, label: string, onPress: () => void) => (
      <Box width={KEY_COLUMNS}>
        <Button key={key} plain hotkey={hotkey} label={label} onPress={onPress} />
      </Box>
    )

    return (
      <Box flexDirection="column" alignItems="center">
        {picture}
        {short ? (
          <Box height={1} overflow="hidden">
            <Button
              key="author"
              plain
              label={`${short.author || 'YouTube'} ↗`}
              onPress={() => void openInBrowser($, short.id)}
            />
          </Box>
        ) : (
          <Text> </Text>
        )}
        {/* Two rows whatever the title's length, so the buttons stay put. */}
        <Box height={2} overflow="hidden">
          <Text wrap="wrap">{short?.title ?? ' '}</Text>
        </Box>
        <Text dimColor wrap="truncate">
          {notes || ' '}
        </Text>
        {/* Two rows of four: eight in one row outgrow the 50 columns asked for. */}
        <Box flexDirection="row" columnGap={KEY_GAP} flexWrap="wrap">
          {cell('next', 'j', 'Next', () => void skip($, 1))}
          {cell('previous', 'k', 'Prev', () => void skip($, -1))}
          {cell('pause', 'p', s.status === 'paused' ? 'Play' : 'Pause', () => void togglePause($))}
          {cell('replay', 'r', 'Replay', () => void skip($, 0))}
        </Box>
        <Box flexDirection="row" columnGap={KEY_GAP} flexWrap="wrap">
          {cell('like', 'l', isLiked ? 'Unlike' : 'Like', () => void toggleLike($))}
          {cell('mute', 'm', s.muted ? 'Unmute' : 'Mute', () => void toggleMute($))}
          {cell('open', 'o', 'Open ↗', () => void (short && openInBrowser($, short.id)))}
          {cell('close', 'x', 'Close', () => void shutDown($).then(() => $.ui.close({ id: PANE })))}
        </Box>
      </Box>
    )
  })

  // The person's close (ctrl+x x, the pane's mark); `x` shuts down itself,
  // since a close the plugin raises does not come back to its own hook.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    await shutDown($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      // A /clear ends the conversation, not the process: the pane, the ffmpeg
      // and the timers carry on, but the host empties `$.state` and fires no
      // `session.start`. Keep what plays for `classic.SessionStart` to put back.
      carried = await read($, shorts)
      return next(e)
    }
    epoch++
    stopPlayer()
    await holdKeys($, false)
    if (dir !== '') await $.process.run(['rm', '-rf', dir], { timeoutMs: 2000 }).catch(() => undefined)
    return next(e)
  })

  // Fires once the session a /clear starts is in place, `$.state` already empty.
  on('classic.SessionStart', async ($, e, next) => {
    const kept = carried
    carried = undefined
    if (e.source === 'clear' && kept !== undefined) await setShorts($, () => ({ ...kept, dir }))
    return next(e)
  })
}

// --- setup -------------------------------------------------------------------

/**
 * Looks for what `/shorts` needs, naming the helpers' Python on the way.
 * Each tool runs from Claude Code's own PATH, as playback runs it: one
 * installed out of that PATH counts as missing.
 */
function checkSetup($: EngineInterface): Promise<Missing[]> {
  checking = (async () => {
    const home = (await $.env.get('HOME')) ?? ''
    const [found, ffmpeg, hasDeno] = await Promise.all([
      findPython($, home),
      $.process.run(['ffmpeg', '-hide_banner', '-devices'], { timeoutMs: 10_000 }).catch(() => undefined),
      succeeds($, ['deno', '--version']),
    ])
    python = found
    const missing: Missing[] = []
    if (found === '') missing.push({ name: 'yt-dlp', why: 'no Python that imports yt_dlp', formula: 'yt-dlp' })
    if (ffmpeg?.exitCode !== 0) missing.push({ name: 'ffmpeg', why: 'not found', formula: 'ffmpeg' })
    else if (!/\baudiotoolbox\b/.test(ffmpeg.stdout)) {
      missing.push({ name: 'ffmpeg', why: 'this ffmpeg has no audiotoolbox output for the sound', formula: 'ffmpeg' })
    }
    if (!hasDeno) {
      const why = "not found; yt-dlp solves YouTube's JS challenges with it and may miss formats without it"
      missing.push({ name: 'deno', why, formula: 'deno', isOptional: true })
    }
    isSetUp = !missing.some(m => !m.isOptional)
    return missing
  })()
  return checking
}

/**
 * A Python that imports yt_dlp: the one the `yt-dlp` on the PATH runs on, by
 * its `#!` line (pipx's, Homebrew's, pip's), else pipx's own wherever its
 * home is (`~/.local/pipx`, or a newer pipx's `~/Library/Application
 * Support/pipx`); '' when none does.
 */
async function findPython($: EngineInterface, home: string): Promise<string> {
  const pythons: string[] = []
  const which = await $.process.run(['which', 'yt-dlp']).catch(() => undefined)
  const script = which?.exitCode === 0 ? which.stdout.trim() : ''
  if (script !== '') {
    const head = await $.process.run(['head', '-n', '1', script]).catch(() => undefined)
    const named = shebangPython(head?.stdout ?? '')
    if (named !== undefined) pythons.push(named)
  }
  const pipxHomes = [await $.env.get('PIPX_HOME'), `${home}/.local/pipx`, `${home}/Library/Application Support/pipx`]
  for (const root of pipxHomes) if (root) pythons.push(`${root}/venvs/yt-dlp/bin/python`)
  for (const candidate of pythons) if (await succeeds($, [candidate, '-c', 'import yt_dlp'])) return candidate
  return ''
}

/** Whether `argv` starts and exits 0 within 10 s. */
const succeeds = ($: EngineInterface, argv: string[]) =>
  $.process.run(argv, { timeoutMs: 10_000 }).then(
    run => run.exitCode === 0,
    () => false,
  )

/** Asks to install what is missing, and hands the install to Claude on a yes. */
async function offerInstall($: EngineInterface, missing: Missing[]) {
  const hasBrew = await succeeds($, ['which', 'brew'])
  // Dismissed, or no one to ask (`-p`): nothing to do.
  const options = { header: 'cc-shorts', options: [INSTALL, 'Not now'] }
  const answer = await $.ui.ask(installQuestion(missing, hasBrew), options).catch(() => '')
  // The person chose it: Claude reads it as their own words.
  if (answer === INSTALL) await $.prompt.submit({ text: installPrompt(missing, hasBrew), asUser: true })
}

/**
 * Asks which browser the person is signed in to YouTube with, offering those
 * used here, and keeps the answer; false when they named none yt-dlp reads.
 */
async function chooseBrowser($: EngineInterface): Promise<boolean> {
  const root = `${(await $.env.get('HOME')) ?? ''}/Library/Application Support`
  const isHere = await Promise.all(
    BROWSERS.map(b => b.dir === undefined || $.fs.exists(`${root}/${b.dir}`).catch(() => false)),
  )
  const here = BROWSERS.filter((_, i) => isHere[i])
  // Safari alone (every Mac has it) leaves nothing to ask.
  const question = { header: 'Browser', options: browserOptions(here, browser) }
  const answer =
    here.length < 2 ? (here[0]?.name ?? '') : await $.ui.ask(browserQuestion(here, browser), question).catch(() => '')
  if (answer === '') return false
  const chosen = findBrowser(answer)
  if (chosen === undefined) {
    $.ui.toast(`cc-shorts: yt-dlp cannot read ${answer}; it reads ${nameList(BROWSERS.map(b => b.name))}`, {
      timeoutMs: 10_000,
    })
    return false
  }
  // Where the feed had scrolled to belongs to the account it scrolled with.
  if (chosen.id !== (browser || 'chrome')) await $.store.delete('token')
  browser = chosen.id
  await $.store.set('browser', browser)
  return true
}

// --- playback ----------------------------------------------------------------

/** Plays the Short at `cur` from `from` seconds, downloading it if need be. */
async function play($: EngineInterface, from = 0) {
  const my = ++epoch
  stopPlayer()
  let s = await read($, shorts)
  if (s.queue.length <= s.cur) {
    await setShortsAt($, my, s => ({ ...s, status: 'loading', message: 'Fetching the feed…' }))
    const error = await refill($)
    if (my !== epoch) return
    s = await read($, shorts)
    if (s.queue.length <= s.cur) {
      const why = error === undefined ? '' : ` (${error})`
      const message = `Could not get the feed${why}. Press j to retry, or switch browsers with /shorts browser`
      await setShortsAt($, my, s => ({ ...s, status: 'error', message }))
      return
    }
  }
  const id = s.queue[s.cur] ?? ''
  if (s.shorts[id]?.path === undefined) {
    await setShortsAt($, my, s => ({ ...s, status: 'loading', message: 'Downloading…' }))
  }
  // Skipped on from already: what plays now goes first, not this one.
  if (my !== epoch) return
  // Waiting since before a skip, and no longer next: those never start.
  const near = nextFew(s)
  dropWaiting(id => near.includes(id))
  const short = await download($, id, true)
  if (my !== epoch) return
  if (short?.path === undefined) {
    if (++failures >= 3) {
      failures = 0
      await setShortsAt($, my, s => ({
        ...s,
        status: 'error',
        message: 'Downloads keep failing. Check the network, then press j to retry',
      }))
      return
    }
    $.ui.toast('cc-shorts: download failed, skipping to the next one')
    await setShortsAt($, my, s => ({ ...s, cur: s.cur + 1, pos: 0 }))
    if (my !== epoch) return
    return play($)
  }
  failures = 0
  void prepare($)
  await start($, short, from, my)
}

async function start($: EngineInterface, short: Short, from: number, my: number) {
  // The first draw of the pane says how big the picture can be.
  for (let i = 0; i < 40 && layout === undefined; i++) await $.clock.sleep(50)
  if (my !== epoch) return
  const s = await read($, shorts)
  const mode = s.mode ?? 'image'
  const box = layout ?? videoBox(50, 40)
  await $.process.run(['mkdir', '-p', dir])
  // Skipped on while this waited: an ffmpeg spawned now would have nothing
  // left to stop it, so the newer play spawns its own.
  if (my !== epoch) return
  const name = `frame-${loadMark}-${++frameSeq}.rgb`
  const frame: Frame = { file: `${dir}/${name}`, ...frameSize(mode, box), ...box }
  const argv = ffmpegArgs({ path: short.path ?? '', start: from, mode, frame, isMuted: s.muted || !short.hasAudio })
  const p: Player = { id: short.id, stream: $.process.spawn({ argv }), mode, frame, start: from, pos: from, stderr: '' }
  player = p
  // Every older frame file: the one shown while paused, and any an ffmpeg
  // still dying wrote after it was stopped.
  void $.process.run(['find', dir, '-name', 'frame-*', '!', '-name', `${name}*`, '-delete'])
  lastSource = undefined
  lastCells = undefined
  // Stopped while this writes: a retried write would draw over the newer one,
  // and the ticker would outlive the stop that already ran.
  await setShortsAt($, my, s => ({ ...s, status: 'playing', message: '', pos: from, frame }))
  if (my !== epoch) return
  void markSeen($, short.id)
  ticker = $.clock.every(33, () => void tick($))
  void follow($, p, short)
}

/** Puts ffmpeg's newest frame on screen; one at a time, about 30 a second. */
async function tick($: EngineInterface) {
  const p = player
  if (p === undefined || isBlitting) return
  isBlitting = true
  try {
    if (layout !== undefined && (layout.columns !== p.frame.columns || layout.rows !== p.frame.rows)) {
      // The pane changed size: start again in the new box, where it was.
      void play($, p.pos)
      return
    }
    let result
    if (p.mode === 'image') {
      const { file, width, height } = p.frame
      const source: ImageSource = { file, format: 'rgb', width, height, generation: ++generation }
      result = await $.ui.blit({ requestId: PANE, key: VIDEO, source })
      if (!result.deny) lastSource = source
    } else {
      const cells = await frameCells($, p.frame)
      result = await $.ui.blit({ requestId: PANE, key: VIDEO, cells })
      if (!result.deny) lastCells = cells
    }
    if (result.deny && player === p) await denied($, p, result.deny)
  } catch {
    // The first frame is not written yet.
  } finally {
    isBlitting = false
  }
}

/** The frame file as Raster cells; rejects while it is not written. */
async function frameCells($: EngineInterface, frame: Frame): Promise<string> {
  const { base64 } = await $.fs.read(frame.file, { as: 'bytes' })
  return toCells(Uint8Array.fromBase64(base64), frame.columns, frame.rows)
}

async function denied($: EngineInterface, p: Player, reason: string) {
  if (p.mode === 'image' && /\balt\b/.test(reason)) {
    // This terminal draws no pictures (iTerm2): cells from here on.
    log($, `no pictures here, falling back to cells: ${reason}`)
    await setShorts($, s => ({ ...s, mode: 'raster' }))
    void play($, p.pos)
    return
  }
  // Not drawn yet, mostly: the next tick tries again.
  if (reason !== lastDeny) log($, `blit refused: ${reason}`)
  lastDeny = reason
}

/** Reads one ffmpeg's progress until it ends, then moves on. */
async function follow($: EngineInterface, p: Player, short: Short) {
  let rest = ''
  let isEnded = false
  let shown = Math.floor(p.pos)
  try {
    for await (const chunk of p.stream) {
      if (chunk.stream === 'stderr') {
        p.stderr = (p.stderr + chunk.text).slice(-2000)
        continue
      }
      const progress = parseProgress(rest + chunk.text)
      rest = progress.rest
      isEnded ||= progress.isEnded
      if (progress.time === undefined || player !== p) continue
      p.pos = p.start + progress.time
      if (Math.floor(p.pos) !== shown) {
        shown = Math.floor(p.pos)
        await setShorts($, s => ({ ...s, pos: p.pos }))
      }
      if (!marked.has(p.id) && p.pos >= Math.min(WATCHED_SECONDS, short.duration / 2)) {
        marked.add(p.id)
        void helper($, 'yt.py', ['watched', p.id], undefined, 60_000)
      }
    }
  } catch (err) {
    p.stderr += String(err)
  }
  // Stopped on purpose: what stopped it carries on, and a stopped stream's
  // result may never settle.
  if (player !== p) return
  const ended = await p.stream.result.catch(() => undefined)
  if (player !== p) return
  stopPlayer()
  if (isEnded && ended?.code === 0) {
    await setShorts($, s => ({ ...s, cur: s.cur + 1, pos: 0 }))
    void play($)
    return
  }
  log($, `ffmpeg ended ${JSON.stringify(ended)}: ${p.stderr}`)
  const why = lastLine(p.stderr)
  await setShorts($, s => ({
    ...s,
    status: 'error',
    pos: p.pos,
    message: `Playback failed${why === '' ? '' : ` (${why})`}. Press j for the next Short`,
  }))
}

function stopPlayer() {
  const p = player
  player = undefined
  ticker?.cancel()
  ticker = undefined
  // Ending the stream ends the ffmpeg.
  if (p) void p.stream.return({ code: null, signal: null }).catch(() => undefined)
}

// --- the feed ----------------------------------------------------------------

type FeedReply = { ids: string[]; token: string | null; source: string; loggedIn: boolean }

/** Pulls the next batch of the feed onto the queue, one call at a time; resolves why it could not. */
function refill($: EngineInterface): Promise<string | undefined> {
  refilling ??= (async () => {
    const s = await read($, shorts)
    const token = await $.store.get('token')
    const seen = ((await $.store.get('seen')) as string[] | undefined) ?? []
    const request = { token: typeof token === 'string' ? token : null, seen: [...seen, ...s.queue], want: 10 }
    const { value: reply, error } = await runHelper<FeedReply>($, 'yt.py', ['feed'], JSON.stringify(request), 120_000)
    if (reply === undefined) return error
    log($, `feed: ${reply.ids.length} from ${reply.source}`)
    if (reply.token === null) await $.store.delete('token')
    else await $.store.set('token', reply.token)
    await setShorts($, s => ({
      ...s,
      queue: [...s.queue, ...reply.ids.filter(id => !s.queue.includes(id))],
      isLoggedIn: reply.loggedIn,
    }))
  })().finally(() => {
    refilling = undefined
  })
  return refilling
}

async function markSeen($: EngineInterface, id: string) {
  const seen = ((await $.store.get('seen')) as string[] | undefined) ?? []
  if (!seen.includes(id)) await $.store.set('seen', [...seen, id].slice(-SEEN_KEPT))
}

// --- downloads ---------------------------------------------------------------

/**
 * The Short downloaded, once. Downloads run one after another in the order
 * asked, except that an `isUrgent` one (the Short to play now) goes ahead of
 * every one still waiting; the one already running finishes first.
 */
function download($: EngineInterface, id: string, isUrgent = false): Promise<Short | undefined> {
  const at = waiting.findIndex(job => job.id === id)
  if (isUrgent && at > 0) waiting.unshift(...waiting.splice(at, 1))
  const known = downloads.get(id)
  if (known) return known
  const job = new Promise<Short | undefined>(resolve => {
    const entry = { id, start: () => fetchShort($, id).then(resolve), drop: () => resolve(undefined) }
    if (isUrgent) waiting.unshift(entry)
    else waiting.push(entry)
  })
  downloads.set(id, job)
  // A failure may pass (a network blip): let a later ask try again.
  void job.then(short => {
    if (short === undefined && downloads.get(id) === job) downloads.delete(id)
  })
  void downloadNext()
  return job
}

/** Starts the downloads waiting, one at a time, until none is left. */
async function downloadNext() {
  if (isDownloading) return
  isDownloading = true
  for (let job = waiting.shift(); job !== undefined; job = waiting.shift()) await job.start()
  isDownloading = false
}

async function fetchShort($: EngineInterface, id: string): Promise<Short | undefined> {
  try {
    const had = (await read($, shorts)).shorts[id]
    if (had?.path !== undefined && (await $.fs.exists(had.path))) return had
    const short = await helper<Short>($, 'yt.py', ['download', id, dir], undefined, 180_000)
    if (short === undefined) return undefined
    await setShorts($, s => ({ ...s, shorts: { ...s.shorts, [id]: short } }))
    return short
  } catch (err) {
    log($, `download ${id}: ${String(err)}`)
    return undefined
  }
}

/** Keeps the next few downloaded, the queue long enough, and old files gone. */
async function prepare($: EngineInterface) {
  const s = await read($, shorts)
  if (s.queue.length - s.cur - 1 <= LOW_WATER) void refill($)
  for (const id of nextFew(s).slice(1)) void download($, id)
  // One behind stays for `k`; the rest are deleted.
  const old = s.queue.slice(0, Math.max(0, s.cur - 1)).filter(id => s.shorts[id]?.path !== undefined)
  if (old.length === 0) return
  await $.process.run(['rm', '-f', ...old.map(id => s.shorts[id]?.path ?? '')])
  for (const id of old) downloads.delete(id)
  await setShorts($, next => {
    const kept = { ...next.shorts }
    for (const id of old) if (kept[id]) kept[id] = { ...kept[id], path: undefined }
    return { ...next, shorts: kept }
  })
}

/** The Short at `cur` and the PRELOAD after it. */
const nextFew = (s: Shorts) => s.queue.slice(s.cur, s.cur + 1 + PRELOAD)

/** Takes each download waiting whose Short `keep` turns down out of line: it never starts. */
function dropWaiting(keep: (id: string) => boolean) {
  const dropped = waiting.filter(job => !keep(job.id))
  waiting.splice(0, waiting.length, ...waiting.filter(job => keep(job.id)))
  for (const job of dropped) job.drop()
}

// --- the input source --------------------------------------------------------

/**
 * Keeps an input method off the hotkeys: a Chinese or Japanese one takes the
 * letters before the terminal sees them. While the pane holds the keyboard
 * the input source is an English layout, and the one it had comes back once
 * the pane lets go; one switch at a time, in order.
 */
function holdKeys($: EngineInterface, isHeld: boolean): Promise<unknown> {
  // Drawn before the setup check named the helper's Python (a hot reload):
  // a later draw acts on it.
  if (isHeld !== hadKeys && python !== '') {
    hadKeys = isHeld
    keysChain = keysChain
      .then(() => (isHeld ? toEnglish($) : giveBackInput($)))
      .catch(err => log($, `input source: ${String(err)}`))
  }
  return keysChain
}

async function toEnglish($: EngineInterface) {
  const reply = await helper<{ was: string | null }>($, 'ime.py', ['english'], undefined, 5000)
  const was = reply?.was
  // Nothing switched (English already): a source kept from before stays.
  if (typeof was === 'string') await setShorts($, s => ({ ...s, inputSource: was }))
}

async function giveBackInput($: EngineInterface) {
  const { inputSource } = await read($, shorts)
  if (inputSource === undefined) return
  await helper($, 'ime.py', ['select', inputSource], undefined, 5000)
  await setShorts($, s => ({ ...s, inputSource: undefined }))
}

// --- what the keys do --------------------------------------------------------

/** Plays the Short `by` along the queue from the start; 0 plays this one again. */
async function skip($: EngineInterface, by: number) {
  await setShorts($, s => ({ ...s, cur: Math.min(s.queue.length, Math.max(0, s.cur + by)), pos: 0 }))
  void play($)
}

async function togglePause($: EngineInterface) {
  const s = await read($, shorts)
  if (s.status === 'paused') return void play($, s.pos)
  await pause($)
}

async function pause($: EngineInterface) {
  const p = player
  if (p !== undefined) {
    epoch++
    stopPlayer()
    await setShorts($, s => ({ ...s, status: 'paused', pos: p.pos }))
    return
  }
  // Nothing on screen yet, but one on its way (the feed, its download, ffmpeg
  // starting): a newer epoch keeps it from starting, and the pane drops the
  // frame of the Short before.
  const { status } = await read($, shorts)
  if (status !== 'loading' && status !== 'playing') return
  // Started while this read: paused as any other.
  if (player !== undefined) return pause($)
  epoch++
  await setShorts($, s => ({ ...s, status: 'paused', message: 'Paused', frame: undefined }))
}

/**
 * Likes the Short on screen, or takes the like back: the pane shows it at
 * once, and YouTube hears of it one call at a time (each about 6 s).
 */
async function toggleLike($: EngineInterface) {
  // Flipped inside the write: two presses landing together flip it twice.
  const s = await setShorts($, s => {
    const id = s.queue[s.cur]
    return id === undefined ? s : { ...s, liked: withLike(s.liked, id, !hasLike(s, id)) }
  })
  const id = s.queue[s.cur]
  if (id === undefined) return
  const isLiked = hasLike(s, id)
  likeChain = likeChain
    .then(async () => {
      // Pressed again since: that press sends its own.
      if (hasLike(await read($, shorts), id) !== isLiked) return
      if ((await helper($, 'yt.py', [isLiked ? 'like' : 'unlike', id], undefined, 60_000)) !== undefined) return
      await setShorts($, s => (hasLike(s, id) === isLiked ? { ...s, liked: withLike(s.liked, id, !isLiked) } : s))
      $.ui.toast(`cc-shorts: ${isLiked ? 'like' : 'unlike'} failed`)
    })
    .catch(err => log($, `like ${id}: ${String(err)}`))
}

const hasLike = (s: Shorts, id: string) => (s.liked ?? []).includes(id)

function withLike(liked: string[] | undefined, id: string, isLiked: boolean): string[] {
  const others = (liked ?? []).filter(i => i !== id)
  return isLiked ? [...others, id] : others
}

async function toggleMute($: EngineInterface) {
  const s = await setShorts($, s => ({ ...s, muted: !s.muted }))
  if (player !== undefined) void play($, player.pos)
  $.ui.toast(s.muted ? 'cc-shorts: muted' : 'cc-shorts: unmuted')
}

/** Pauses here first, so the browser's copy is not heard over this one. */
async function openInBrowser($: EngineInterface, id: string) {
  await pause($)
  await $.process.run(['open', `https://www.youtube.com/shorts/${id}`])
}

/** Stops everything and deletes this session's downloads and frames. */
async function shutDown($: EngineInterface) {
  epoch++
  stopPlayer()
  // What has not started never does: the folder it would land in goes below.
  dropWaiting(() => false)
  downloads.clear()
  layout = undefined
  await setShorts($, s => ({
    ...s,
    status: 'idle',
    frame: undefined,
    shorts: Object.fromEntries(Object.entries(s.shorts).map(([id, short]) => [id, { ...short, path: undefined }])),
  }))
  // No draw sees the keyboard go: an idle pane holds none, a closed one draws no more.
  await holdKeys($, false)
  if (dir !== '') await $.process.run(['rm', '-rf', dir])
}
