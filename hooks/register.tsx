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
import { blankCells, clockTime, ffmpegArgs, frameSize, lastLine, parseProgress, toCells, videoBox } from './lib'
import type { Box } from './lib'

const PANE = 'shorts'
const VIDEO = 'video'
/** Videos kept downloaded ahead of the one playing. */
const PRELOAD = 2
/** Refill the queue when this few are left after the one playing. */
const LOW_WATER = 5
/** How many watched ids `$.store` keeps, so the feed skips them. */
const SEEN_KEPT = 1000
/** A Short counts as watched (and goes to the account's history) after this. */
const WATCHED_SECONDS = 10
/** The widest key the pane draws (`r: Replay`, `o: Open ↗`), and the space between keys. */
const KEY_COLUMNS = 9
const KEY_GAP = 2

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
let python = ''
let player: Player | undefined
let ticker: Timer | undefined
let isBlitting = false
let lastDeny = ''
/** Bumped by every action that changes what plays; stale work checks it. */
let epoch = 0
/**
 * Frame files are counted per load, so the load's start goes in their names
 * too: a reload counts from 1 again, and ffmpeg will not write over a file
 * the last load left behind.
 */
const loadMark = Date.now().toString(36)
let frameSeq = 0
let generation = 0
/** The box the pane last drew the picture in, from the render hook. */
let layout: Box | undefined
/** What the picture shows now, so a redraw draws the same. */
let lastSource: ImageSource | undefined
let lastCells: string | undefined
let refilling: Promise<void> | undefined
let downloadChain: Promise<unknown> = Promise.resolve()
let likeChain: Promise<unknown> = Promise.resolve()
/** Downloads failed in a row: past a few, the network is down, not the video. */
let failures = 0
const downloads = new Map<string, Promise<Short | undefined>>()
const marked = new Set<string>()
/** What `shorts` held when a /clear began, for the session after it. */
let carried: Shorts | undefined
/** Whether the pane held the keyboard at its last draw: each change acts once. */
let hadKeys = false
let keysChain: Promise<unknown> = Promise.resolve()

const log = ($: EngineInterface, text: string) => $.ui.log(text, { to: 'debug' })
const setShorts = ($: EngineInterface, change: (s: Shorts) => Shorts) => update($, shorts, change)

/** Runs a script of `helper/` and parses the JSON it prints; undefined on failure. */
async function helper<T>(
  $: EngineInterface,
  script: 'yt.py' | 'ime.py',
  args: string[],
  stdin: string | undefined,
  timeoutMs: number,
): Promise<T | undefined> {
  try {
    const run = await $.process.run([python, '-B', `${$.plugin.root}/helper/${script}`, ...args], { stdin, timeoutMs })
    if (run.exitCode === 0) return JSON.parse(lastLine(run.stdout)) as T
    log($, `${script} ${args[0]} failed: ${lastLine(run.stderr)}`)
  } catch (err) {
    log($, `${script} ${args[0]} failed: ${String(err)}`)
  }
  return undefined
}

// --- the hooks ---------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')
    dir = `${tmp}/cc-shorts/${await $.session.id()}`
    python = `${(await $.env.get('HOME')) ?? ''}/.local/pipx/venvs/yt-dlp/bin/python`
    await $.command.register({ name: 'shorts', description: 'Scroll your YouTube Shorts feed in a side pane' })
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
    hadKeys = s.inputSource !== undefined
    if (!isOpen) void holdKeys($, false)
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

  on('command.run', { command: 'shorts' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Shorts', focus: true, columns: 50, rows: 40 })
    const s = await read($, shorts)
    if (s.status === 'idle' || s.status === 'error') void play($, s.pos)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>cc-shorts plays only in the terminal.</Text>
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
      s.isLoggedIn ? '' : 'Signed out: not your feed',
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
    if (e.source === 'clear' && kept !== undefined) await setShorts($, () => kept)
    return next(e)
  })
}

// --- playback ----------------------------------------------------------------

/** Plays the Short at `cur` from `from` seconds, downloading it if need be. */
async function play($: EngineInterface, from = 0) {
  const my = ++epoch
  stopPlayer()
  let s = await read($, shorts)
  if (s.queue.length <= s.cur) {
    await setShorts($, s => ({ ...s, status: 'loading', message: 'Fetching the feed…' }))
    await refill($)
    if (my !== epoch) return
    s = await read($, shorts)
    if (s.queue.length <= s.cur) {
      await setShorts($, s => ({ ...s, status: 'error', message: 'Could not get the feed; press j to retry' }))
      return
    }
  }
  const id = s.queue[s.cur] ?? ''
  if (s.shorts[id]?.path === undefined) {
    await setShorts($, s => ({ ...s, status: 'loading', message: 'Downloading…' }))
  }
  const short = await download($, id)
  if (my !== epoch) return
  if (short?.path === undefined) {
    if (++failures >= 3) {
      failures = 0
      await setShorts($, s => ({
        ...s,
        status: 'error',
        message: 'Downloads keep failing; check the network, then press j to retry',
      }))
      return
    }
    $.ui.toast('cc-shorts: download failed, skipping to the next one')
    await setShorts($, s => ({ ...s, cur: s.cur + 1, pos: 0 }))
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
  await setShorts($, s => ({ ...s, status: 'playing', message: '', pos: from, frame }))
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
  await setShorts($, s => ({
    ...s,
    status: 'error',
    pos: p.pos,
    message: `Playback failed: ${lastLine(p.stderr) || 'unknown reason'} (j for next)`,
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

/** Pulls the next batch of the feed onto the queue; one call at a time. */
function refill($: EngineInterface): Promise<void> {
  refilling ??= (async () => {
    const s = await read($, shorts)
    const token = await $.store.get('token')
    const seen = ((await $.store.get('seen')) as string[] | undefined) ?? []
    const request = { token: typeof token === 'string' ? token : null, seen: [...seen, ...s.queue], want: 10 }
    const reply = await helper<FeedReply>($, 'yt.py', ['feed'], JSON.stringify(request), 120_000)
    if (reply === undefined) return
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

/** The Short downloaded, once; downloads run one after another. */
function download($: EngineInterface, id: string): Promise<Short | undefined> {
  const known = downloads.get(id)
  if (known) return known
  const job = downloadChain.then(async () => {
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
  })
  downloadChain = job
  downloads.set(id, job)
  // A failure may pass (a network blip): let a later ask try again.
  void job.then(short => {
    if (short === undefined) downloads.delete(id)
  })
  return job
}

/** Keeps the next few downloaded, the queue long enough, and old files gone. */
async function prepare($: EngineInterface) {
  const s = await read($, shorts)
  if (s.queue.length - s.cur - 1 <= LOW_WATER) void refill($)
  for (const id of s.queue.slice(s.cur + 1, s.cur + 1 + PRELOAD)) void download($, id)
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
  if (p === undefined) return
  epoch++
  stopPlayer()
  await setShorts($, s => ({ ...s, status: 'paused', pos: p.pos }))
}

/** Pauses here first, so the browser's copy is not heard over this one. */
async function openInBrowser($: EngineInterface, id: string) {
  await pause($)
  await $.process.run(['open', `https://www.youtube.com/shorts/${id}`])
}

async function toggleMute($: EngineInterface) {
  const s = await setShorts($, s => ({ ...s, muted: !s.muted }))
  if (player !== undefined) void play($, player.pos)
  $.ui.toast(s.muted ? 'cc-shorts: muted' : 'cc-shorts: unmuted')
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

/** Stops everything and deletes this session's downloads and frames. */
async function shutDown($: EngineInterface) {
  epoch++
  stopPlayer()
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

// --- the input source --------------------------------------------------------

/**
 * Keeps an input method off the hotkeys: a Chinese or Japanese one takes the
 * letters before the terminal sees them. While the pane holds the keyboard
 * the input source is an English layout, and the one it had comes back once
 * the pane lets go; one switch at a time, in order.
 */
function holdKeys($: EngineInterface, isHeld: boolean): Promise<unknown> {
  // Drawn before `session.start` named the helper's Python (a hot reload):
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
