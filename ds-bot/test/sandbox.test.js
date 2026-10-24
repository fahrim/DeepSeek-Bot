import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DLL_INIT_FAILED, exitCodeOf, install, noteText } from '../src/host/sandbox.js'
import { fakeContext } from './fake-ctx.js'

// The note is about the Windows file sandbox, so the tests that ask for it run on Windows
// (CI runs there too); the helpers that decide it are covered on every platform.
const windowsOnly = { skip: process.platform !== 'win32' && 'the note is about the Windows file sandbox' }
const marker = `[exit code: ${DLL_INIT_FAILED}]`
const launched = { isError: false, content: [{ type: 'text', text: `(no output)\n${marker}` }] }
const EXEC = {
  name: 'pwsh',
  arguments: { command: 'Get-ChildItem -Path . -Recurse', workdir: 'C:\\team\\site' },
  agent: { id: 'b', session: { id: 'b' } },
}

// A Bot Session in a group, its Main Bot, and the sandbox it stands in. `confined` is
// whether the mounted shell offers a one-shot escalation.
function setup({ mode = 'workspace-write', confined = true, owned = true, room, failures = [] } = {}) {
  const ctx = fakeContext({
    services: {
      sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: 'C:\\team' }) },
      ...(confined ? { shell: { sandboxMode: mode } } : {}),
    },
  })
  const rt = {
    ctx,
    config: {},
    load: async () => {},
    isBotSession: id => owned && id === 'b',
    selfOf: id => (id === 'b' ? 'writer' : undefined),
    botOf: id => (id === 'writer' ? { name: 'Writer' } : undefined),
    roomOf: id => (id === 'b' ? room : undefined),
    noteFailure: (entry) => { failures.push(entry) },
    warn: () => {},
  }
  install(rt)
  const hook = ctx.listeners.get('tools/post-execute')[0]
  const run = ({ result, exec, downstream } = {}) => hook(
    { ...EXEC, ...exec },
    result ?? launched,
    async () => downstream ?? { kind: 'accept' },
  )
  return { run, failures }
}

test('the exit code comes from the marker DSH appends last, and from nowhere else', () => {
  assert.equal(exitCodeOf(launched.content), DLL_INIT_FAILED)
  assert.equal(exitCodeOf([{ type: 'text', text: marker }]), DLL_INIT_FAILED)
  assert.equal(exitCodeOf([{ type: 'text', text: `42\n${marker}\nmore output` }]), undefined)
  assert.equal(exitCodeOf([{ type: 'text', text: 'ok' }]), undefined)
  assert.equal(exitCodeOf([{ type: 'text', text: 'output' }, { type: 'image', source: {} }]), undefined)
  assert.equal(exitCodeOf([]), undefined)
  assert.equal(exitCodeOf(undefined), undefined)
})

test('the note names the sandbox, the command and the folder, and flattens a multi-line command', () => {
  const text = noteText({ mode: 'workspace-write', command: 'Get-Date\r\n\tRemove-Item x', workdir: 'C:\\team', escalateTo: 'danger-full-access' })
  assert.equal(text.split('\n').length, 3)
  assert.match(text, /0xC0000142, STATUS_DLL_INIT_FAILED/)
  assert.match(text, /mode workspace-write, folder C:\\team, command Get-Date Remove-Item x\]\n/)
  assert.match(text, /sandbox_permissions "danger-full-access"/)
})

test('a command too long to read is cut, and a short one is kept whole', () => {
  const long = noteText({ mode: 'workspace-write', command: 'x'.repeat(400) })
  assert.match(long, /command x{300}…\]/)
  assert.doesNotMatch(long, /x{301}/)
  assert.match(noteText({ mode: 'workspace-write', command: 'ls' }), /command ls\]/)
})

test('without a one-shot escape the note sends the user to the settings', () => {
  const text = noteText({ mode: 'workspace-write', command: 'ls', workdir: 'C:\\team' })
  assert.match(text, /ask them to give this Bot full file access in the settings/)
  assert.doesNotMatch(text, /sandbox_permissions/)
})

test('a confined launch failure reaches the Bot as context, and is logged once per Session and mode', windowsOnly, async () => {
  const failures = []
  const { run } = setup({ failures })
  const decision = await run()
  assert.equal(decision.kind, 'accept')
  // DSH reads the exit marker off the last line, so the note must not touch the content.
  assert.equal(decision.content, undefined)
  const [context] = decision.additionalContexts
  assert.deepEqual(context.source, { kind: 'ds-bot-sandbox', form: 'notice', summary: 'sandbox could not start a command (workspace-write)' })
  assert.match(context.content[0].text, /mode workspace-write, folder C:\\team\\site, command Get-ChildItem -Path \. -Recurse/)
  assert.match(context.content[0].text, /sandbox_permissions "danger-full-access"/)
  assert.deepEqual(failures, [{
    level: 'warn',
    source: 'host',
    code: 'SANDBOX_LAUNCH',
    text: 'the Windows file sandbox could not start a command under workspace-write mode: exit code 3221225794 (0xC0000142, STATUS_DLL_INIT_FAILED), folder C:\\team\\site, command Get-ChildItem -Path . -Recurse',
    bot: 'Writer',
    where: 'own chat',
    sessionId: 'b',
  }])
  await run()
  assert.equal(failures.length, 1)
})

test('a group Session is logged where it happened', windowsOnly, async () => {
  const failures = []
  const { run } = setup({ failures, room: { id: 'r1', name: 'Ops' } })
  await run()
  assert.equal(failures[0].where, 'group "Ops"')
})

test('read-only gets the user path, not a retry that stays confined', windowsOnly, async () => {
  const { run } = setup({ mode: 'read-only' })
  const [context] = (await run()).additionalContexts
  assert.match(context.content[0].text, /mode read-only/)
  assert.match(context.content[0].text, /full file access in the settings/)
  assert.doesNotMatch(context.content[0].text, /sandbox_permissions/)
})

test('a Session without an escalation lever still gets the note, without asking for one', windowsOnly, async () => {
  const { run } = setup({ confined: false })
  const [context] = (await run()).additionalContexts
  assert.match(context.content[0].text, /full file access in the settings/)
  assert.doesNotMatch(context.content[0].text, /sandbox_permissions/)
})

test('a real crash outside the sandbox, another exit code, and a failed result get no note', async () => {
  const { run, failures } = setup({ mode: 'danger-full-access' })
  assert.equal((await run()).additionalContexts, undefined)
  assert.equal((await setup().run({ result: { isError: false, content: [{ type: 'text', text: '(no output)\n[exit code: 1]' }] } })).additionalContexts, undefined)
  assert.equal((await setup().run({ result: { ...launched, isError: true } })).additionalContexts, undefined)
  const kept = { kind: 'accept', additionalContexts: [{ id: 'm', role: 'user' }] }
  assert.equal((await run({ downstream: kept })).additionalContexts.length, 1)
  assert.deepEqual(failures, [])
})

test('a Session that is not a Bot\'s gets no note and no log entry', async () => {
  const failures = []
  const { run } = setup({ failures, owned: false })
  assert.equal((await run()).additionalContexts, undefined)
  assert.deepEqual(failures, [])
})
