// The pure parts of the player: sizes, the ffmpeg command, its progress
// output, and frames as Raster cells. No `$` here, so tests reach all of it.

import type { Frame, Mode } from '../types'

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

/** The JSON a helper command printed: its last line. */
export function lastLine(text: string): string {
  return text.trim().split('\n').pop() ?? ''
}
