import { describe, expect, test } from 'claude-code/testing'

import {
  blankCells,
  CHROME_ROWS,
  clockTime,
  ffmpegArgs,
  frameSize,
  parseProgress,
  toCells,
  videoBox,
} from '../hooks/lib'

describe('videoBox', () => {
  test('a tall pane: the width decides, 9 columns to 8 rows', async () => {
    expect(videoBox(36, 60)).toEqual({ columns: 36, rows: 32 })
  })

  test('a short pane: the height decides, and the chrome fits under it', async () => {
    const box = videoBox(120, 30)
    expect(box.rows).toBeLessThanOrEqual(30 - CHROME_ROWS)
    expect(box.columns).toBe(Math.floor(((30 - CHROME_ROWS) * 9) / 8))
  })

  test('never wider than an Image may be', async () => {
    expect(videoBox(400, 400).columns).toBe(255)
  })
})

describe('frameSize', () => {
  test('raster: a pixel per column, two per row', async () => {
    expect(frameSize('raster', { columns: 36, rows: 32 })).toEqual({ width: 36, height: 64 })
  })

  test('image: about ten pixels a column, 9:16, at most 480 wide', async () => {
    expect(frameSize('image', { columns: 36, rows: 32 })).toEqual({ width: 360, height: 640 })
    expect(frameSize('image', { columns: 200, rows: 178 }).width).toBe(480)
  })
})

describe('ffmpegArgs', () => {
  const frame = { file: '/tmp/f.rgb', width: 36, height: 64, columns: 36, rows: 32 }

  test('plays from the start point, sound to the speakers', async () => {
    const argv = ffmpegArgs({ path: '/tmp/a.mp4', start: 12.5, mode: 'image', frame, isMuted: false })
    expect(argv.join(' ')).toContain('-ss 12.50 -re -i /tmp/a.mp4')
    expect(argv.join(' ')).toContain('-update 1 -atomic_writing 1 /tmp/f.rgb')
    expect(argv.slice(-5)).toEqual(['-map', '0:a:0', '-f', 'audiotoolbox', '-'])
  })

  test('muted: no sound output; raster: 32 colors a frame', async () => {
    const argv = ffmpegArgs({ path: '/tmp/a.mp4', start: 0, mode: 'raster', frame, isMuted: true })
    expect(argv).not.toContain('audiotoolbox')
    expect(argv.join(' ')).toContain('palettegen=max_colors=32')
  })
})

describe('parseProgress', () => {
  test('reads the time and the end, keeping a cut line for the next piece', async () => {
    const first = parseProgress('frame=10\nout_time_us=2500000\nprogress=continue\nout_ti')
    expect(first).toEqual({ time: 2.5, isEnded: false, rest: 'out_ti' })
    const second = parseProgress(`${first.rest}me_us=3000000\nprogress=end\n`)
    expect(second).toEqual({ time: 3, isEnded: true, rest: '' })
  })

  test('skips a time ffmpeg does not know yet', async () => {
    expect(parseProgress('out_time_us=N/A\n').time).toBeUndefined()
  })
})

describe('toCells', () => {
  test('one cell: an upper half block, the upper pixel over the lower', async () => {
    const cells = toCells(Uint8Array.of(0xff, 0x80, 0x00, 0x00, 0x00, 0xff), 1, 1)
    const words = new Uint32Array(Uint8Array.fromBase64(cells).buffer)
    expect([...words]).toEqual([0x2580, 0xff8000, 0x0000ff])
  })

  test('cells are row-major over pixel rows two at a time', async () => {
    // 2 x 2 pixels: red, green / blue, white.
    const rgb = Uint8Array.of(255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255)
    const words = new Uint32Array(Uint8Array.fromBase64(toCells(rgb, 2, 1)).buffer)
    expect([...words]).toEqual([0x2580, 0xff0000, 0x0000ff, 0x2580, 0x00ff00, 0xffffff])
  })

  test('a blank box has a cell for every column and row', async () => {
    expect(Uint8Array.fromBase64(blankCells(3, 2)).length).toBe(3 * 2 * 12)
  })
})

test('clockTime', async () => {
  expect(clockTime(0)).toBe('0:00')
  expect(clockTime(75.9)).toBe('1:15')
})
