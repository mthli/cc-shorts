/** One Short as its download describes it. */
export type Short = {
  id: string
  title: string
  author: string
  /** Seconds. */
  duration: number
  /** False for the rare Short with no sound track: played muted. */
  hasAudio: boolean
  /** The downloaded mp4, absent until downloaded (or once cleaned up). */
  path?: string
}

/**
 * How a frame reaches the pane: `image`, real pixels (kitty, Ghostty);
 * `raster`, half-block cells, two pixels a cell (iTerm2 and the rest).
 */
export type Mode = 'image' | 'raster'

/** The frame file the running ffmpeg rewrites, and the box it is drawn in. */
export type Frame = {
  file: string
  width: number
  height: number
  columns: number
  rows: number
}

export type Status = 'idle' | 'loading' | 'playing' | 'paused' | 'error'

/** The feed and the player, as the pane draws them. */
export type Shorts = {
  /** Video ids in feed order; `cur` is the one on screen. */
  queue: string[]
  cur: number
  shorts: Record<string, Short>
  status: Status
  /** What the pane says while there is no picture, or what went wrong. */
  message: string
  /** Seconds into the current Short. */
  pos: number
  muted: boolean
  /** Undecided until the first frame: `image` is tried first. */
  mode?: Mode
  frame?: Frame
  /** False when the last feed call came back logged out. */
  isLoggedIn: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'cc-shorts': { shorts: Shorts }
  }
}
