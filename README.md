# claude-mods

Two mods (add-ons) that change how Claude itself behaves.

## auto-handoff

Long chats fill up. When they do, Claude squeezes the old part into a short summary (compaction), and details get lost.

This mod stops that:

1. Just before the squeeze, Claude writes a full **handoff note**: goal, decisions, what is done (with file paths and ids), what is in progress, next steps, what waits on you, rules and gotchas.
2. The note is kept **word for word** in the summary, so the chat carries on with nothing important lost.
3. A copy is saved in `.claude/handoffs/` in the chat's working folder.
4. When the chat passes 80% full, you get one short notice.
5. Type **`/handoff`** any time to make a note now (for example before starting a new chat). Claude then offers to save it as `HANDOVER.md` in your project.

Settings (`/config`): the handoff folder, and when to warn.

## second-check

A second AI watches over Claude.

1. **After each answer** a quick, low-cost model compares what you asked with what Claude did. If something important was missed, it shows up to 3 short points under the answer: **"You should know"**.
2. **Before anything is published or deployed** (blog posts, WordPress changes, `git push`, `wrangler deploy`, Vercel production), a second AI checks it against **your rules** and can stop it, with the reasons. Claude then fixes it and tries again.
3. Type **`/check`** for a full second review of the whole chat.

Settings (`/config`): switch the answer review or the publish check on or off, the review model (default `haiku`), what counts as publishing, your rules, and whether to allow or block when the check itself cannot run.

The default rules are for an Islamic healing centre's websites: Quran and sahih hadith only, no health or cure promises, no invented facts or reviews, prices that match, no secrets in anything published, and code deployed only after tests passed. Change them in `/config`.

## Install

At the prompt of a terminal session:

```
/plugin install auto-handoff --marketplace kingkader/claude-mods
/plugin install second-check --marketplace kingkader/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user = every session).

From a shell:

```
claude plugin install auto-handoff --marketplace kingkader/claude-mods
claude plugin install second-check --marketplace kingkader/claude-mods
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `kingkader/claude-mods`, then **Add plugin**.

## Costs

- auto-handoff: one extra model call each time a chat is squeezed, or when you type `/handoff`.
- second-check: one small model call after each longer answer, and one check before each publish or deploy. All billed to your own Claude account.

## Tests

Each mod has tests: `claude plugin test auto-handoff` and `claude plugin test second-check`.

MIT licence.
