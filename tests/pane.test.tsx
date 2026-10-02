import { expect, test } from 'claude-code/testing'

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

test('before anything plays: the hint, and the five keys', async $ => {
  const ui = await $.ui.mount({ plugin: 'cc-shorts', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'Run /shorts to start' })).toBeDefined()
  for (const label of ['Previous', 'Pause', 'Next', 'Mute', 'Close']) {
    expect(await ui.find({ type: 'Button', text: label })).toBeDefined()
  }
  await ui.unmount()
})

test('off the terminal it says so instead of drawing a player', async $ => {
  const ui = await $.ui.mount({ plugin: 'cc-shorts', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /only in the terminal/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  await ui.unmount()
})
