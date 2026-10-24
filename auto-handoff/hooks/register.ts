import type { EngineInterface, Register, SessionMessage } from 'claude-code'

// auto-handoff: before a long chat is squeezed into a short summary (compaction),
// write a full handoff note and keep it word for word in that summary, so nothing
// important is lost. /handoff writes one on demand.

const NOTE_PROMPT = `Write a HANDOFF NOTE for this conversation so a fresh session can carry on with nothing lost.
Use plain markdown and short lines, with exactly these sections:

## Goal
What the person wants, in their own words.
## Decisions
Every decision the person made (and when). Say who decided.
## Done
What is finished and checked. Give exact file paths, URLs, ids, names and commands.
## In progress
What was being worked on when this note was written, and how far it got.
## Next steps
Numbered, in order.
## Waiting on the person
Questions or actions only the person can do.
## Rules and gotchas
How the person likes to work, rules to follow, things that failed and the fix,
where secrets live (names and paths only).

Never write a password, API key or token. Be specific, not general. At most 900 words.
Reply with the note only.`

const KEEP = (note: string) =>
  `A handoff note was written just before this compaction. Copy it into the summary WORD FOR WORD under the heading "Handoff note", then summarise the rest of the conversation as usual.\n\n${note}`

type Saved = { at: string; path: string; chars: number; how: 'fork' | 'fallback' }

const stamp = async ($: EngineInterface) =>
  new Date(await $.clock.now()).toISOString().slice(0, 16).replace(/[:T]/g, '-')

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

// A plain note built from the transcript itself, used when the model could not answer.
function fallbackNote(messages: readonly SessionMessage[]): string {
  const asks = messages
    .filter(m => m.role === 'user' && m.text.trim() !== '' && !(m.toolResults && m.toolResults.length))
    .slice(-8)
    .map((m, i) => `${i + 1}. ${clip(m.text.trim().replace(/\s+/g, ' '), 300)}`)
  const actions = messages
    .flatMap(m => m.toolUses)
    .slice(-15)
    .map(t => {
      const input = t.input as Record<string, unknown>
      const what = String(input.file_path ?? input.path ?? input.command ?? input.url ?? '').replace(/\s+/g, ' ')
      return `- ${t.tool}${what ? `: ${clip(what, 120)}` : ''}${t.isError ? ' (failed)' : ''}`
    })
  const lastAnswer = [...messages].reverse().find(m => m.role === 'assistant' && m.text.trim() !== '')
  return [
    '## Goal (the person\'s last requests)', ...asks,
    '', '## Last actions', ...actions,
    '', '## Last answer', clip(lastAnswer ? lastAnswer.text.trim() : '(none)', 1500),
  ].join('\n')
}

type Ctx = { folder: string; lastNote: { text: string; at: number } | null }

// Writes the note, saves a copy, remembers it. Never throws.
async function makeNote($: EngineInterface, ctx: Ctx): Promise<{ text: string; how: Saved['how']; path?: string; why?: string }> {
  const now = await $.clock.now()
  if (ctx.lastNote && now - ctx.lastNote.at < 10 * 60 * 1000) return { text: ctx.lastNote.text, how: 'fork' }
  let text = ''
  let how: Saved['how'] = 'fork'
  let why: string | undefined
  const reply = await $.model.fork({ prompt: NOTE_PROMPT })
  if (reply.isAnswered && reply.text.trim().length > 200) {
    text = reply.text.trim()
  } else {
    why = reply.isAnswered ? 'the note came back empty' : reply.reason
    how = 'fallback'
    text = fallbackNote(await $.session.messages())
  }
  const header = `# Handoff note — ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC\n\n`
  let path: string | undefined = `${ctx.folder}/${await stamp($)}.md`
  try {
    await $.fs.write(path, header + text + '\n')
  } catch {
    path = undefined
  }
  try {
    const list = ((await $.store.get('saved')) as Saved[] | undefined) ?? []
    await $.store.set('saved', [...list, { at: new Date(now).toISOString(), path: path ?? '(not saved)', chars: text.length, how }].slice(-20))
    await $.store.set('last', header + text)
  } catch { /* the note still goes into the summary */ }
  ctx.lastNote = { text, at: now }
  return { text, how, path, why }
}


export const register: Register = (on, options) => {
  const ctx: Ctx = { folder: String(options.folder ?? '.claude/handoffs').replace(/\/+$/, ''), lastNote: null }
  const warnAt = Number(options.warnAtPercent ?? 80)
  let warned = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'handoff',
      description: 'Write a handoff note now (what is done, decided, next), so a new chat can carry on',
    })
    return next(e)
  })

  on('command.run', { command: 'handoff' }, async $ => {
    ctx.lastNote = null
    const note = await makeNote($, ctx)
    const where = note.path ? `Saved to ${note.path}.` : 'Could not save a file here; the note is below.'
    return {
      text: `${where}${note.how === 'fallback' ? ` (Short version: ${note.why}.)` : ''}\n\n${note.text}`,
      context: [
        'The person ran /handoff. If this chat works on a project folder you can reach (for example a connected folder on their computer), offer once to save this note as HANDOVER.md there. Do not save it without their yes.',
      ],
    }
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const note = await makeNote($, ctx)
    const result = await next({ ...e, instructions: [e.instructions, KEEP(note.text)].filter(Boolean).join('\n\n') })
    if (e.trigger !== 'precompute') {
      warned = false
      $.ui.toast(
        note.how === 'fork'
          ? `Handoff kept ✓ ${note.path ? `(copy in ${note.path})` : ''}`
          : `Short handoff kept (${note.why})`,
      )
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    const pct = e.context.percent
    if (pct !== undefined && pct !== null) {
      if (!warned && pct >= warnAt) {
        warned = true
        $.ui.toast(`This chat is ${Math.round(pct)}% full. A handoff note will be kept when it is squeezed. Type /handoff to make one now.`)
      }
      if (pct < warnAt - 20) warned = false
    }
    return next(e)
  })
}
