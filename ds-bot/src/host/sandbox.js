// A confined command on Windows that never started. The process dies while its DLLs
// initialize, so it prints nothing and the shell tool reports a bare exit code, which a
// Bot reads as a command that failed. The note names the sandbox, the command and the
// folder, and says what to do instead; the diagnostics entry keeps the same facts where
// the user can copy them into a report (issue #523).
import { createUserMessage } from '@deepseek-ai/dsh-llm'

// 0xC0000142 STATUS_DLL_INIT_FAILED as the unsigned 32-bit exit code the shell reports.
export const DLL_INIT_FAILED = 3221225794
const SOURCE = 'ds-bot-sandbox'
// DSH's shell tools close a non-zero result with this marker alone on the last line.
const EXIT_MARKER = /(?:^|\n)\[exit code: (\d+)\]$/u
// The strictly wider mode a one-shot sandbox escalation may ask for, from DSH's table.
// A retry that lands in another confined mode would fail the same way, so only
// `danger-full-access` is an escape from this.
const WIDER_MODE = { 'read-only': 'workspace-write', 'workspace-write': 'danger-full-access' }
const COMMAND_MAX = 300

/**
 * The exit code a shell result closed with, or `undefined` when its last block is not
 * the marker DSH's shell tools append. Other results, errors included, are not ours.
 */
export function exitCodeOf(content) {
  const last = Array.isArray(content) ? content.at(-1) : undefined
  if (last?.type !== 'text' || typeof last.text !== 'string') return undefined
  const match = EXIT_MARKER.exec(last.text)
  return match === null ? undefined : Number(match[1])
}

const oneLine = (text) => {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length > COMMAND_MAX ? `${flat.slice(0, COMMAND_MAX)}…` : flat
}

// What the Bot reads instead of the bare exit code. `escalateTo` is the mode a one-shot
// retry may name, when the mounted shell offers one and it leaves the sandbox.
export function noteText({ mode, command, workdir, escalateTo }) {
  const facts = [
    `mode ${mode}`,
    workdir === undefined ? undefined : `folder ${workdir}`,
    command === undefined ? undefined : `command ${oneLine(command)}`,
  ].filter(Boolean).join(', ')
  const action = escalateTo === undefined
    ? 'Do not retry the same call unchanged. Tell the user, in their own language, that the Windows file sandbox cannot start processes here, and ask them to give this Bot full file access in the settings before it can run commands again.'
    : `Do not retry the same call unchanged. Retry this exact call once with sandbox_permissions "${escalateTo}" and a justification; the user is asked to approve it, and it then runs outside the file sandbox. Say in one sentence, in the user's language, that the Windows file sandbox cannot start processes here.`
  return [
    `[sandbox: this command never ran. Under a confined mode on Windows a process can die while its DLLs initialize; the shell tool then reports exit code ${DLL_INIT_FAILED} (0xC0000142, STATUS_DLL_INIT_FAILED) and no output. The command is not at fault.]`,
    `[sandbox: ${facts}]`,
    action,
  ].join('\n')
}

export function install(rt) {
  const { ctx } = rt
  // One diagnostics entry per Session and mode; the note is what the Bot reads each time.
  const noted = new Set()

  const remember = (id, { mode, command, workdir }) => {
    const key = `${id}|${mode}`
    if (noted.has(key)) return
    noted.add(key)
    try {
      const room = rt.roomOf(id)
      rt.noteFailure({
        level: 'warn',
        source: 'host',
        code: 'SANDBOX_LAUNCH',
        text: `the Windows file sandbox could not start a command under ${mode} mode: exit code ${DLL_INIT_FAILED} (0xC0000142, STATUS_DLL_INIT_FAILED)${workdir === undefined ? '' : `, folder ${workdir}`}${command === undefined ? '' : `, command ${oneLine(command)}`}`,
        bot: rt.botOf(rt.selfOf(id))?.name,
        where: room === undefined ? 'own chat' : `group "${room.name}"`,
        sessionId: id,
      })
    } catch (error) {
      // A diagnostics log that cannot be written must not lose the note itself.
      rt.warn?.('ds-bot: the sandbox launch failure was not logged: %s', error)
    }
  }

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (process.platform !== 'win32' || result.isError === true) return downstream
    if (exitCodeOf(result.content) !== DLL_INIT_FAILED) return downstream
    const agent = exec.agent
    if (agent === undefined) return downstream
    await rt.load()
    const id = agent.id
    if (!rt.isBotSession(id)) return downstream
    const mode = ctx.get?.('sandboxPolicy')?.resolve?.({ session: agent.session })?.mode
    // Unconfined, this exit code is a real crash: the sandbox is not the reason.
    if (mode === undefined || mode === 'danger-full-access') return downstream
    const command = typeof exec.arguments?.command === 'string' ? exec.arguments.command : undefined
    const workdir = typeof exec.arguments?.workdir === 'string' ? exec.arguments.workdir : undefined
    const wider = WIDER_MODE[mode]
    // DSH advertises sandbox_permissions exactly when the mounted shell confines, and a
    // retry only escapes the sandbox when it may leave every confined mode.
    const escalateTo = ctx.get?.('shell')?.sandboxMode !== undefined && wider === 'danger-full-access' ? wider : undefined
    remember(id, { mode, command, workdir })
    const note = createUserMessage({
      content: [{ type: 'text', text: noteText({ mode, command, workdir, escalateTo }) }],
      source: { kind: SOURCE, form: 'notice', summary: `sandbox could not start a command (${mode})` },
    })
    return { ...downstream, additionalContexts: [...downstream.additionalContexts ?? [], note] }
  })
}
