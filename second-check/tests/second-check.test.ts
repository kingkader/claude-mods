import { expect, test } from 'claude-code/testing'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const answered = (text: string) => ({ value: { isAnswered: true, text, usage: USAGE } })
const LONG_ANSWER = 'Done. I fixed all 16 titles and checked them live. '.repeat(12)

type Seen = { forks: string[]; completes: string[]; toasts: string[]; ran: string[] }

function engineBeneath(on: Parameters<Parameters<typeof test>[1]>[1], seen: Seen, reply: { fork?: string; complete?: string }) {
  on('model.fork', (_, e) => {
    seen.forks.push(String((e as { prompt: string }).prompt))
    return answered(reply.fork ?? 'PASS')
  })
  on('model.complete', (_, e) => {
    seen.completes.push(String((e as { prompt: string }).prompt))
    return answered(reply.complete ?? 'NOTHING')
  })
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'Fix the 16 titles and also the homepage description', toolUses: [] },
      { role: 'assistant', text: 'On it.', toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'python3 fix_titles.py' } }] },
    ],
  }))
  on('ui.toast', (_, e) => {
    seen.toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('tool.call', (_, e) => {
    seen.ran.push(String((e as { command?: string }).command))
    return { result: 'ran' }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
}

const fresh = (): Seen => ({ forks: [], completes: [], toasts: [], ran: [] })

test('after an answer, a missed point is shown under it', async ($, on) => {
  const seen = fresh()
  engineBeneath(on, seen, { complete: '1. The homepage description was asked for but not changed.' })
  const out = await $.turn.complete({ answer: LONG_ANSWER, reason: 'answer', durationMs: 1000, isAborted: false, turnId: 't' })
  expect(out.text).toContain('Second check')
  expect(out.text).toContain('homepage description')
  expect(seen.completes[0]).toContain('Fix the 16 titles')
})

test('when nothing is missed, the answer is left alone', async ($, on) => {
  const seen = fresh()
  engineBeneath(on, seen, { complete: 'NOTHING' })
  const out = await $.turn.complete({ answer: LONG_ANSWER, reason: 'answer', durationMs: 1000, isAborted: false, turnId: 't' })
  expect(out.text).toBe(LONG_ANSWER)
})

test('a publish that breaks a rule is stopped before it runs', async ($, on) => {
  const seen = fresh()
  engineBeneath(on, seen, { fork: 'BLOCK: the post quotes a weak hadith; it promises a cure for eczema' })
  const out = await $.tool.call({ tool: 'Bash', command: 'python3 sr_blog.py publish posts/x.json' })
  expect(JSON.stringify(out)).toContain('weak hadith')
  expect(seen.ran.length).toBe(0)
  expect(seen.forks[0]).toContain('sr_blog.py publish')
})

test('a publish that passes goes ahead', async ($, on) => {
  const seen = fresh()
  engineBeneath(on, seen, { fork: 'PASS' })
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  expect(seen.ran).toEqual(['git push origin main'])
  expect(seen.toasts.join(' ')).toContain('passed')
})

test('ordinary commands are not checked', async ($, on) => {
  const seen = fresh()
  engineBeneath(on, seen, { fork: 'BLOCK: should never be asked' })
  await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  expect(seen.forks.length).toBe(0)
  expect(seen.ran).toEqual(['ls -la'])
})

test('the publish check can be switched off', { options: { guardPublishing: false } }, async ($, on) => {
  const seen = fresh()
  engineBeneath(on, seen, { fork: 'BLOCK: x' })
  await $.tool.call({ tool: 'Bash', command: 'python3 sr_blog.py publish posts/x.json' })
  expect(seen.ran.length).toBe(1)
})

test('publishing through the computer shell tool is checked too', async ($, on) => {
  const seen = fresh()
  engineBeneath(on, seen, { fork: 'BLOCK: invented statistic' })
  const out = await $.tool.call({ tool: 'mcp__remote-devices__device_bash', command: 'python3 sr_blog.py publish posts/y.json' })
  expect(JSON.stringify(out)).toContain('invented statistic')
  expect(seen.ran.length).toBe(0)
})
