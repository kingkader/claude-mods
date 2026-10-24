import { expect, test } from 'claude-code/testing'

const NOTE = '## Goal\nShip the example app.\n## Decisions\n- The owner chose plan B.\n## Done\n- Tests pass (npm test).\n## Next steps\n1. Deploy to staging.\n' + 'x'.repeat(200)
const MSGS = [{ role: 'user' as const, text: 'hello', toolUses: [] }]
const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

function engineBeneath(on: Parameters<Parameters<typeof test>[1]>[1], seen: { instructions?: string; written: string[]; toasts: string[] }, forkAnswers: boolean) {
  on('clock.now', () => ({ value: Date.UTC(2026, 9, 24, 10, 0) }))
  on('model.fork', () => ({
    value: forkAnswers
      ? { isAnswered: true, text: NOTE, usage: USAGE }
      : { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error', usage: USAGE },
  }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'Please fix the titles on the blog', toolUses: [] },
      { role: 'assistant', text: 'Fixing now.', toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'python3 fix.py' } }] },
    ],
  }))
  on('fs.write', (_, e) => {
    seen.written.push(String((e as { path: string }).path))
    return { value: undefined }
  })
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    seen.toasts.push(String((e as { text?: string }).text ?? JSON.stringify(e)))
    return { value: undefined }
  })
  on('session.compact', (_, e) => {
    seen.instructions = e.instructions
    return { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }
  })
}

test('before compacting, the handoff note is kept word for word and saved', async ($, on) => {
  const seen = { written: [] as string[], toasts: [] as string[] } as { instructions?: string; written: string[]; toasts: string[] }
  engineBeneath(on, seen, true)
  await $.session.compact({ trigger: 'auto', messages: MSGS })
  expect(seen.instructions).toContain('WORD FOR WORD')
  expect(seen.instructions).toContain('The owner chose plan B.')
  expect(seen.written[0]).toMatch(/\.claude\/handoffs\/2026-10-24-10-00\.md$/)
  expect(seen.toasts.join(' ')).toContain('Handoff kept')
})

test('when the model cannot answer, a short note from the transcript is kept', async ($, on) => {
  const seen = { written: [] as string[], toasts: [] as string[] } as { instructions?: string; written: string[]; toasts: string[] }
  engineBeneath(on, seen, false)
  await $.session.compact({ trigger: 'auto', messages: MSGS })
  expect(seen.instructions).toContain('Please fix the titles on the blog')
  expect(seen.instructions).toContain('python3 fix.py')
  expect(seen.toasts.join(' ')).toContain('Short handoff kept')
})

test('a subagent compaction is left alone', async ($, on) => {
  const seen = { written: [] as string[], toasts: [] as string[] } as { instructions?: string; written: string[]; toasts: string[] }
  engineBeneath(on, seen, true)
  await $.session.compact({ trigger: 'auto', messages: MSGS, agentId: 'a1' })
  expect(seen.instructions).toBeUndefined()
  expect(seen.written.length).toBe(0)
})

test('/handoff writes a note on demand and offers to save it in the project', async ($, on) => {
  const seen = { written: [] as string[], toasts: [] as string[] } as { instructions?: string; written: string[]; toasts: string[] }
  engineBeneath(on, seen, true)
  on('command.register', () => ({ value: { command: 'handoff' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const out = await $.command.run({ command: 'handoff', args: '', origin: { kind: 'composer' } })
  expect(JSON.stringify(out)).toContain('Saved to')
  expect(JSON.stringify(out)).toContain('HANDOVER.md')
  expect(seen.written.length).toBe(1)
})
