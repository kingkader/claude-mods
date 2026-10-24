import type { EngineInterface, Register, SessionMessage } from 'claude-code'

// second-check: a second AI watches over Claude.
// 1. After each answer: a quick review lists anything important that was missed ("You should know").
// 2. Before a command that publishes or deploys: a check against the owner's rules, which can stop it.
// 3. /check: a full review of the whole chat on demand.

const REVIEW_SYSTEM = `You are a careful second reviewer of an AI assistant's work for a busy owner who reads best in short, plain lines.
Compare what the person asked with what the assistant did and answered.
If nothing important is wrong or missing, reply with exactly: NOTHING
Otherwise reply with at most 3 numbered points, most important first, each under 20 words, in plain words. Only flag:
- a part of the request that was not done or not answered;
- something said to be done, fixed or working that the actions do not show;
- a claim that looks unchecked or wrong;
- a risk or a step the person must take that the answer did not make clear.
No praise. Do not repeat the answer. Do not flag style.`

const GATE = (command: string, rules: string) => `STOP AND CHECK, as an independent second reviewer.
The assistant is about to run this command, which publishes or deploys something:

${command.slice(0, 3000)}

The owner's rules:
${rules}

Look at what is being published or deployed as it appears earlier in this conversation (the text of the post or page, the code change, the test results).
Reply with ONE first line, exactly one of:
PASS
BLOCK: <at most 3 reasons, plain words>
Block only when something clearly breaks a rule. If you cannot see the content, judge from what you can see and PASS unless there is a clear problem. Do not block for style or small doubts.`

const FULL_REVIEW = `Review this whole conversation as an independent second checker for the owner.
What did the assistant miss, get wrong, promise without doing, or leave unfinished? What must the owner know or do?
Reply with at most 5 numbered points, most important first, each under 25 words, in plain words.
If everything is fine, reply with exactly: NOTHING`

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

function commandOf(e: unknown): string {
  const o = e as { command?: unknown; input?: { command?: unknown } }
  if (typeof o.command === 'string') return o.command
  if (o.input && typeof o.input.command === 'string') return o.input.command
  return ''
}

// The person's last typed request, and what the assistant did after it.
function lastExchange(messages: readonly SessionMessage[]): { request: string; actions: string[] } {
  let i = messages.length - 1
  while (i >= 0) {
    const m = messages[i]
    if (m && m.role === 'user' && m.text.trim() !== '' && !(m.toolResults && m.toolResults.length)) break
    i -= 1
  }
  const request = i >= 0 ? (messages[i]?.text ?? '') : ''
  const actions = messages
    .slice(Math.max(i, 0))
    .flatMap(m => m.toolUses)
    .map(t => {
      const input = t.input as Record<string, unknown>
      const what = String(input.command ?? input.file_path ?? input.path ?? input.url ?? input.query ?? '').replace(/\s+/g, ' ')
      return `- ${t.tool}${what ? `: ${clip(what, 140)}` : ''}${t.isError ? ' → FAILED' : ''}`
    })
  return { request, actions }
}

async function reviewAnswer($: EngineInterface, model: string, answer: string): Promise<string | null> {
  const { request, actions } = lastExchange(await $.session.messages())
  if (answer.length < 400 && actions.length === 0) return null
  const prompt = `THE PERSON ASKED:\n${clip(request, 3000)}\n\nWHAT THE ASSISTANT DID (tool calls, newest last):\n${actions.slice(-40).join('\n') || '(none)'}\n\nTHE ANSWER:\n${clip(answer, 8000)}`
  const r = await $.model.complete({ model, system: REVIEW_SYSTEM, prompt, maxTokens: 300, timeoutMs: 30000 })
  if (!r.isAnswered) return null
  const text = r.text.trim()
  return /^NOTHING\b/i.test(text) ? null : text
}

async function checkPublish($: EngineInterface, command: string, rules: string, model: string, isSubagent: boolean) {
  const prompt = GATE(command, rules)
  return isSubagent ? $.model.complete({ model, prompt, maxTokens: 300, timeoutMs: 60000 }) : $.model.fork({ prompt })
}

export const register: Register = (on, options) => {
  const reviewAnswers = options.reviewAnswers !== false
  const model = String(options.reviewModel ?? 'haiku')
  const guard = options.guardPublishing !== false
  const rules = String(options.rules ?? '')
  const blockOnFailure = options.ifCheckFails === 'block'
  let pattern: RegExp | null = null
  try {
    pattern = new RegExp(String(options.publishPattern ?? ''), 'i')
  } catch {
    pattern = null
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'check',
      description: 'Second check: review this whole chat for anything missed, wrong or unfinished',
    })
    return next(e)
  })

  on('command.run', { command: 'check' }, async $ => {
    const r = await $.model.fork({ prompt: FULL_REVIEW })
    if (!r.isAnswered) return { text: `The second check could not run (${r.reason}).` }
    const text = r.text.trim()
    return {
      text: /^NOTHING\b/i.test(text) ? '🔎 Second check: nothing important missed.' : `🔎 Second check — you should know:\n${text}`,
      context: ['This is an independent second review of the chat. Do not argue with it; fix what is right, and say plainly if a point is wrong and why.'],
    }
  })

  // 1. After each answer of the main chat: what was missed, shown under the answer.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!reviewAnswers || e.agentId !== undefined || e.reason !== 'answer') return result
    const points = await reviewAnswer($, model, result.text || e.answer)
    if (!points) return result
    return { ...result, text: `🔎 Second check — you should know:\n${points}` }
  })

  // 2. Before publishing or deploying: check against the owner's rules.
  on('tool.call', async ($, e, next) => {
    const command = commandOf(e)
    if (!guard || !pattern || command === '' || !pattern.test(command)) return next(e)
    const verdict = await checkPublish($, command, rules, model, e.agentId !== undefined)
    if (!verdict.isAnswered) {
      if (blockOnFailure) return { deny: `Second check could not run (${verdict.reason}), so this was stopped. Try again in a minute.` }
      $.ui.toast(`Second check could not run (${verdict.reason}). Went ahead.`)
      return next(e)
    }
    const first = verdict.text.trim()
    if (/^BLOCK/i.test(first)) {
      const why = first.replace(/^BLOCK:?\s*/i, '').slice(0, 1200)
      $.ui.toast('Second check stopped a publish. See the reason in the chat.')
      return { deny: `Second check stopped this before it went live: ${why}\nFix these points, then run it again.` }
    }
    $.ui.toast('Second check passed ✓')
    return next(e)
  }).catch(($, e, next) =>
    next.called || !blockOnFailure ? next(e) : { deny: 'Second check failed to run, so this was stopped. Try again in a minute.' },
  )
}
