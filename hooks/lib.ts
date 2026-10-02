// The pure parts of the player: the words of the setup check and the browser
// question, sizes, the ffmpeg command, its progress output, and frames as
// Raster cells. No `$` here, so tests reach all of it.

import type { Frame, Mode } from '../types'

/** The JSON a helper command printed: its last line. */
export function lastLine(text: string): string {
  return text.trim().split('\n').pop() ?? ''
}

// --- setup -------------------------------------------------------------------

/** Something `/shorts` needs that the setup check could not find, or use. */
export type Missing = {
  /** What the person knows it by. */
  name: string
  /** Why it counts as missing, for Claude to start from. */
  why: string
  /** The Homebrew formula that brings it. */
  formula: string
  /** Shorts play without it, only worse. */
  isOptional?: boolean
}

/** The interpreter a script's `#!` line names, `env` looked through; undefined when it names none. */
export function shebangPython(firstLine: string): string | undefined {
  const [exe, ...rest] = firstLine.startsWith('#!') ? firstLine.slice(2).trim().split(/\s+/) : []
  return (exe?.endsWith('/env') ? rest.find(word => !word.startsWith('-')) : exe) || undefined
}

/** `['a', 'b', 'c']` as `a, b and c`. */
export function nameList(names: string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** The `brew install` that brings everything in `missing`. */
export function brewCommand(missing: Missing[]): string {
  return `brew install ${[...new Set(missing.map(m => m.formula))].join(' ')}`
}

const isNeeded = (missing: Missing[]) => missing.filter(m => !m.isOptional)

/** What a session starts with while something is missing; undefined when nothing is. */
export function setupToast(missing: Missing[]): string | undefined {
  if (missing.length === 0) return undefined
  const lacks = `cc-shorts: ${nameList(missing.map(m => m.name))} ${missing.length > 1 ? 'are' : 'is'} missing`
  // Only deno is optional: yt-dlp solves YouTube's JS challenges with it.
  if (isNeeded(missing).length === 0) return `${lacks}, so yt-dlp may miss formats; run ${brewCommand(missing)}`
  return `${lacks}; /shorts offers to install ${missing.length > 1 ? 'them' : 'it'}`
}

/** What `/shorts` asks while something it needs is missing. */
export function installQuestion(missing: Missing[], hasBrew: boolean): string {
  const optional = missing.filter(m => m.isOptional).map(m => m.name)
  const helps = optional.length > 0 ? `, plus ${nameList(optional)}, which helps yt-dlp find formats` : ''
  const lacks = `cc-shorts is missing ${nameList(isNeeded(missing).map(m => m.name))}${helps}.`
  if (!hasBrew) return `${lacks} Homebrew, which installs them, is missing too. Ask Claude to walk you through it?`
  return `${lacks} Install with \`${brewCommand(missing)}\`?`
}

/** What Claude is asked once the person lets it install what is missing. */
export function installPrompt(missing: Missing[], hasBrew: boolean): string {
  const command = brewCommand(missing)
  return [
    'Install what the cc-shorts plugin is missing on this Mac:',
    ...missing.map(m => `- ${m.name}: ${m.why}`),
    '',
    hasBrew
      ? `Run \`${command}\`. It can take several minutes: give it a long timeout.`
      : 'Homebrew is missing too. Do not install it yourself: its installer asks for my password, so tell me to ' +
        `run the one from https://brew.sh in my own terminal, then run \`${command}\` once it is in.`,
    "cc-shorts runs these from Claude Code's PATH: if I have one already, find out why cc-shorts cannot see it.",
    // Homebrew 7 warns about every untrusted tap on an install, with the
    // `brew trust` and `brew untap` lines that would silence it.
    'Each formula is in homebrew/core, which needs no tap trust. Brew may warn that other taps are not trusted; ' +
      'that warning does not block this install, so leave it and run no `brew trust` or `brew untap`.',
    'If brew needs sudo, a password or anything else from me, stop and tell me what it said.',
    'Once it is done, tell me to run /shorts again.',
  ].join('\n')
}

// --- the browser -------------------------------------------------------------

/**
 * A browser yt-dlp reads cookies from on macOS: yt-dlp's name for it, the
 * person's, and its folder under `~/Library/Application Support`, there once
 * it has been used here.
 */
export type Browser = { id: string; name: string; dir?: string }

/** Every browser yt-dlp reads, the likeliest first. Safari has no folder to look for: every Mac has it. */
export const BROWSERS: readonly Browser[] = [
  { id: 'chrome', name: 'Chrome', dir: 'Google/Chrome' },
  { id: 'safari', name: 'Safari' },
  { id: 'edge', name: 'Edge', dir: 'Microsoft Edge' },
  { id: 'firefox', name: 'Firefox', dir: 'Firefox/Profiles' },
  { id: 'brave', name: 'Brave', dir: 'BraveSoftware/Brave-Browser' },
  { id: 'opera', name: 'Opera', dir: 'com.operasoftware.Opera' },
  { id: 'vivaldi', name: 'Vivaldi', dir: 'Vivaldi' },
  { id: 'chromium', name: 'Chromium', dir: 'Chromium' },
  { id: 'whale', name: 'Whale', dir: 'Naver/Whale' },
]

/** The browser an answer names, by either name, or within it (`Google Chrome`); undefined for one yt-dlp cannot read. */
export function findBrowser(answer: string): Browser | undefined {
  const said = answer.trim().toLowerCase()
  if (said === '') return undefined
  return (
    BROWSERS.find(b => said === b.id || said === b.name.toLowerCase()) ??
    BROWSERS.find(b => said.split(/\s+/).includes(b.id))
  )
}

/** The browser question's choices: the browsers here, the one in use first, four at most (the dialog's limit). */
export function browserOptions(here: readonly Browser[], current: string): string[] {
  return [...here.filter(b => b.id === current), ...here.filter(b => b.id !== current)].slice(0, 4).map(b => b.name)
}

/**
 * The browser question, naming the browsers here that do not fit in its
 * choices, and what Safari's cookies cost: macOS lets only an app with Full
 * Disk Access read them, and that app is the terminal, for all it runs.
 */
export function browserQuestion(here: readonly Browser[], current: string): string {
  const offered = browserOptions(here, current)
  const others = here.filter(b => !offered.includes(b.name)).map(b => b.name)
  const [are, it] = others.length > 1 ? ['are', 'one'] : ['is', 'it']
  const more = others.length > 0 ? ` ${nameList(others)} ${are} on this Mac too: type ${it} in.` : ''
  const safari = offered.includes('Safari') ? ' Picking Safari means giving your terminal Full Disk Access.' : ''
  return `Which browser are you signed in to YouTube with? cc-shorts reads your feed through its cookies.${more}${safari}`
}

// --- the pane and playback ---------------------------------------------------

/** Rows under the picture: author, title (two), status line, buttons (two). */
export const CHROME_ROWS = 6

export type Box = { columns: number; rows: number }

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

/**
 * The largest 9:16 box of cells that fits the pane's body above the chrome.
 * A cell is about twice as tall as it is wide, so 9:16 is 9 columns for
 * every 8 rows.
 */
export function videoBox(bodyColumns: number, bodyRows: number): Box {
  const room = Math.max(2, bodyRows - CHROME_ROWS)
  const columns = clamp(Math.min(bodyColumns, Math.floor((room * 9) / 8)), 2, 255)
  return { columns, rows: clamp(Math.round((columns * 8) / 9), 1, room) }
}

/**
 * The pixels of one frame: in `raster` one per column and two per row (the
 * upper and lower half of `▀`); in `image` about ten per column, which the
 * terminal scales to the box, at most 480 wide (the download's width).
 */
export function frameSize(mode: Mode, box: Box): { width: number; height: number } {
  if (mode === 'raster') return { width: box.columns, height: box.rows * 2 }
  const width = even(clamp(box.columns * 10, 96, 480))
  return { width, height: even((width * 16) / 9) }
}

/**
 * The ffmpeg that plays one Short from `start` seconds at its own pace: each
 * frame rewrites `frame.file` whole (a rename, so a reader never sees half a
 * frame), the sound goes straight to the speakers, and the progress comes as
 * `key=value` lines on stdout.
 *
 * `raster` frames are cut to 32 colors each, so the cells use at most
 * 32 x 32 = 1024 color pairs: what the Raster paints without falling back
 * to nearest colors.
 */
export function ffmpegArgs(o: { path: string; start: number; mode: Mode; frame: Frame; isMuted: boolean }): string[] {
  const { width: w, height: h } = o.frame
  const fit = `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=${o.mode === 'raster' ? 'area' : 'bilinear'},pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`
  const palette =
    'split[a][b];[a]palettegen=max_colors=32:stats_mode=single:reserve_transparent=0[p];[b][p]paletteuse=new=1:dither=none'
  const filter = o.mode === 'raster' ? `${fit},${palette},format=rgb24` : `${fit},format=rgb24`
  // prettier-ignore
  return [
    'ffmpeg', '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-progress', 'pipe:1', '-stats_period', '0.25',
    '-ss', o.start.toFixed(2), '-re', '-i', o.path,
    '-map', '0:v:0', '-vf', filter, '-c:v', 'rawvideo',
    '-f', 'image2', '-update', '1', '-atomic_writing', '1', o.frame.file,
    ...(o.isMuted ? [] : ['-map', '0:a:0', '-f', 'audiotoolbox', '-']),
  ]
}

export type Progress = {
  /** Seconds played since this ffmpeg started, when a line said so. */
  time?: number
  /** True once ffmpeg reported `progress=end`. */
  isEnded: boolean
  /** A line cut off at the end of the text: lead the next piece with it. */
  rest: string
}

/** Reads ffmpeg's `-progress` lines out of one piece of its stdout. */
export function parseProgress(text: string): Progress {
  const lines = text.split('\n')
  const rest = lines.pop() ?? ''
  let time: number | undefined
  let isEnded = false
  for (const line of lines) {
    const [key, value] = line.trim().split('=')
    if (key === 'out_time_us' && value !== undefined && /^\d+$/.test(value)) time = Number(value) / 1e6
    if (key === 'progress' && value === 'end') isEnded = true
  }
  return { time, isEnded, rest }
}

const UPPER_HALF = 0x2580
const DEFAULT_COLOR = 0x01000000

/**
 * One rgb24 frame of `columns` x `rows * 2` pixels as Raster cells: each
 * cell a `▀` whose foreground is the upper pixel and background the lower.
 */
export function toCells(rgb: Uint8Array, columns: number, rows: number): string {
  const words = new Uint32Array(columns * rows * 3)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const top = (2 * y * columns + x) * 3
      const bottom = top + columns * 3
      const cell = (y * columns + x) * 3
      words[cell] = UPPER_HALF
      words[cell + 1] = ((rgb[top] ?? 0) << 16) | ((rgb[top + 1] ?? 0) << 8) | (rgb[top + 2] ?? 0)
      words[cell + 2] = ((rgb[bottom] ?? 0) << 16) | ((rgb[bottom + 1] ?? 0) << 8) | (rgb[bottom + 2] ?? 0)
    }
  }
  return new Uint8Array(words.buffer).toBase64()
}

/** Cells for a box with nothing to show yet: black. */
export function blankCells(columns: number, rows: number): string {
  const words = new Uint32Array(columns * rows * 3)
  for (let cell = 0; cell < words.length; cell += 3) {
    words[cell] = 0x20
    words[cell + 1] = DEFAULT_COLOR
    words[cell + 2] = 0
  }
  return new Uint8Array(words.buffer).toBase64()
}

/** `75` as `1:15`. */
export function clockTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
