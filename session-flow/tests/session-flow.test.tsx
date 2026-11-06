import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, TestBody } from 'claude-code/testing'
import type {
  AgentInfo,
  On,
  RenderSurface,
  ToolCallInput,
  ToolCallResult,
  UiPane,
} from 'claude-code'

import { formatDuration } from '../hooks/flow-pane'
import {
  cellWidth,
  clipToCells,
  firstSentence,
  flattenToOneLine,
} from '../hooks/one-line'

const PANE_ID = 'session-flow'
const WIDE_COLUMNS = 60
const SESSION_ID = 'session-1'
const PROJECT = '/projects/shop'
const NO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}
const CLOCK_TIME = /^\d\d:\d\d$/
const EMPTY_LOG = '아직 기록이 없어요. 일을 시키면 여기에 쌓입니다.'
const ENGINE_BAND = '엔진 띠'

const paneProps = (bodyColumns: number) =>
  ({
    title: '세션 흐름',
    isFocused: false,
    bodyColumns,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  }) as const

/** 도구별로 엔진의 답을 바꿀 때 쓴다. undefined면 성공으로 답한다. */
type ToolAnswer = (call: ToolCallInput) => ToolCallResult | undefined

function memoryStore(on: On, seed: Record<string, unknown>) {
  const entries = new Map(Object.entries(seed))
  on('store.get', (_, e) => ({ value: entries.get(e.key) }))
  on('store.set', (_, e) => {
    entries.set(e.key, e.value)

    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    entries.delete(e.key)

    return { value: undefined }
  })

  return entries
}

/** 테스트에서는 플러그인 아래에 엔진이 없다. 이 훅들이 엔진 대신 답한다. */
function standInForEngine(
  on: On,
  {
    sessionId = SESSION_ID,
    stored = {} as Record<string, unknown>,
    answerToolCall = (() => undefined) as ToolAnswer,
  } = {},
): {
  clock: MockClock
  store: Map<string, unknown>
  agents: AgentInfo[]
} {
  const store = memoryStore(on, stored)
  const clock = mock.clock(on)
  const agents: AgentInfo[] = []
  on('agent.list', () => ({ value: agents }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: sessionId }))
  on('session.root', () => ({ value: PROJECT }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('classic.SessionStart', () => ({}))
  on('command.register', () => ({ value: { command: 'flow' } }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', (_, e) => answerToolCall(e) ?? { result: {}, text: '' })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{ENGINE_BAND}</Text>
  })

  return { clock, store, agents }
}

async function linesOnPane(
  $: Engine,
  surface: RenderSurface = 'terminal',
  bodyColumns = WIDE_COLUMNS,
): Promise<string[]> {
  const ui = await $.ui.mount({
    plugin: 'session-flow',
    surface,
    component: 'Pane',
    requestId: PANE_ID,
    props: paneProps(bodyColumns),
  })
  const boxes = await ui.findAll({ type: 'Box' })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()

  // 줄은 머리표와 내용이 나뉘어 있어 줄을 묶는 Box의 글로 읽는다.
  const rows = boxes.filter(found => found.key?.startsWith('row:'))
  const standalone = texts.filter(
    found => CLOCK_TIME.test(found.text) || found.text === EMPTY_LOG,
  )

  return [...rows, ...standalone].map(found => found.text)
}

const personPrompt = (text: string) =>
  ({ text, wait: false, origin: { kind: 'composer' } }) as const

/** 사람이 친 글이 턴을 시작하는 순서를 그대로 일으킨다. */
async function submitPrompt($: Engine, text: string) {
  await $.prompt.submit(personPrompt(text))
  await $.turn.start({ text, turnId: `turn-${text}` })
}

async function completeTurn($: Engine, answer: string, durationMs = 65_000) {
  await $.turn.complete({
    answer,
    durationMs,
    isAborted: false,
    turnId: 'turn',
    reason: 'answer',
  })
}

async function spawnAgent(
  $: Engine,
  description: string,
  parentAgentId?: string,
) {
  await $.agent.spawn({
    tool_use_id: `tool-${description}`,
    prompt: '시킨 일',
    description,
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    parentAgentId,
    background: false,
    fork: false,
  })
}

/** 상태 확인을 기다리는 시간까지 합쳐 시계를 100초 움직인다. */
const AGENT_RUN_MS = 100_000
const AGENT_STATUS_SETTLE_MS = 300

async function finishAgentTurn(
  $: Engine,
  clock: MockClock,
  agentId: string,
  reason: 'answer' | 'error' = 'answer',
) {
  await clock.advance(AGENT_RUN_MS - AGENT_STATUS_SETTLE_MS)
  await $.turn.complete({
    answer: '보고',
    durationMs: 1_000,
    isAborted: false,
    turnId: 'agent-turn',
    agentId,
    reason,
  })
  await clock.advance(AGENT_STATUS_SETTLE_MS)
}

const agentInfo = (id: string, status: AgentInfo['status']) =>
  ({ id, status, description: '일', type: 'general-purpose' }) as AgentInfo

async function runTool(
  $: Engine,
  call: Record<string, unknown> & { tool: string },
  agentId?: string,
) {
  await $.tool.call({ ...call, agentId } as Parameters<Engine['tool']['call']>[0])
}

test('시킨 일부터 결과까지 흐름이 한 줄씩 쌓인다', async ($, on) => {
  const { clock } = standInForEngine(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))

  await submitPrompt($, '로그 모드 만들어 줘')
  await runTool($, { tool: 'Read', file_path: '/repo/src/app.ts' })
  await runTool($, { tool: 'WebSearch', query: 'claude code mods', mode: 'standard' })
  await runTool($, { tool: 'Skill', skill: 'superpowers:brainstorming' })
  await spawnAgent($, '시안 평가')
  await finishAgentTurn($, clock, 'agent-1')
  await runTool($, { tool: 'Edit', file_path: '/repo/src/app.ts' })
  await completeTurn($, '**로그 모드**를 만들었습니다. 자세한 내용은 아래에 있습니다.')

  expect(await linesOnPane($)).toEqual(
    expect.arrayContaining([
      '❯ 로그 모드 만들어 줘',
      '  · 조사 app.ts',
      '  · 검색 claude code mods',
      '  · 스킬 brainstorming',
      '  · 에이전트 ✓ 1분 40초 시안 평가 · sonnet',
      '  · 수정 app.ts',
      '✓ 1분 5초 · 로그 모드를 만들었습니다.',
    ]),
  )
})

test('일반 명령은 남기지 않고 커밋·푸시·PR만 남긴다', async ($, on) => {
  standInForEngine(on, {
    answerToolCall: call => {
      if (call.tool !== 'Bash') {
        return undefined
      }

      const output = /git commit -m/.test(call.command)
        ? '[main 1a2b3c] 로그 창 추가\n 3 files changed'
        : call.command.includes('pr create')
          ? 'https://github.com/owner/repo/pull/7'
          : '출력'

      return { result: {}, text: output }
    },
  })

  await submitPrompt($, '올려 줘')
  await runTool($, { tool: 'Bash', command: 'ls -la && npm test' })
  await runTool($, { tool: 'Bash', command: 'grep "git commit" notes.md' })
  await runTool($, {
    tool: 'Bash',
    command: `git add . && git commit -m "$(cat <<'EOF'\n로그 창 추가\nEOF\n)"`,
  })
  await runTool($, { tool: 'Bash', command: 'git push -u origin main' })
  await runTool($, { tool: 'Bash', command: 'gh pr create --fill' })

  const lines = await linesOnPane($)
  expect(lines).toContain('  · 커밋 로그 창 추가')
  expect(lines).toContain('  · 푸시 원격에 올림')
  expect(lines).toContain('  · PR https://github.com/owner/repo/pull/7')
  expect(lines.join('\n')).not.toContain('npm test')
  expect(lines.join('\n')).not.toContain('notes.md')
})

test('출력이 없는 커밋도 명령에서 제목을 찾아 남긴다', async ($, on) => {
  standInForEngine(on)

  await submitPrompt($, '커밋해')
  await runTool($, { tool: 'Bash', command: 'git add . && git commit -q -m "조용한 커밋"' })
  await runTool($, { tool: 'Skill', skill: 'review' })
  await runTool($, {
    tool: 'Bash',
    command: `git commit -q -m "$(cat <<'EOF'\n여러 줄 커밋\n\n본문\nEOF\n)"`,
  })
  await runTool($, { tool: 'Skill', skill: 'review' })
  await runTool($, { tool: 'Bash', command: 'git commit -q --amend --no-edit' })

  const lines = await linesOnPane($)
  expect(lines).toContain('  · 커밋 조용한 커밋')
  expect(lines).toContain('  · 커밋 여러 줄 커밋')
  expect(lines).toContain('  · 커밋 새 커밋')
})

test('다른 명령의 인자에 든 git 낱말은 커밋이나 푸시로 치지 않는다', async ($, on) => {
  standInForEngine(on)

  await submitPrompt($, '찾아봐')
  await runTool($, { tool: 'Bash', command: 'grep "git commit" notes.md' })
  await runTool($, { tool: 'Bash', command: 'grep "git push" notes.md' })
  await runTool($, { tool: 'Bash', command: 'npx commit-checker "git push origin"' })
  await runTool($, { tool: 'Bash', command: 'git stash push' })
  await runTool($, { tool: 'Bash', command: `git commit -q -m "feat: add push notification"` })

  const lines = await linesOnPane($)
  expect(lines.join('\n')).not.toContain('· 푸시')
  expect(lines.filter(line => line.startsWith('  · 커밋'))).toEqual([
    '  · 커밋 feat: add push notification',
  ])
})

test('읽기 전용 명령은 조사로 묶고 설명을 쓴다', async ($, on) => {
  standInForEngine(on)

  await submitPrompt($, '찾아봐')
  await runTool($, {
    tool: 'Bash',
    command: 'grep -rn price src | sort | head -20',
    description: 'price 쓰임 찾기',
  })
  await runTool($, {
    tool: 'Bash',
    command: 'T=/tmp/a.d.ts; sed -n 1,20p $T 2>/dev/null',
    description: '타입 앞부분 읽기',
  })
  await runTool($, { tool: 'Bash', command: 'cd src && git log --oneline', description: '커밋 기록 보기' })

  expect(await linesOnPane($)).toContain('  · 조사 price 쓰임 찾기, 타입 앞부분 읽기 외 1개')
})

test('따옴표 안의 기호는 명령 구조로 보지 않는다', async ($, on) => {
  standInForEngine(on)

  await submitPrompt($, '찾아봐')
  await runTool($, { tool: 'Bash', command: "grep -E 'a|b' notes.md", description: '둘 중 하나 찾기' })
  await runTool($, { tool: 'Bash', command: "awk '$1 > 3' data.txt", description: '큰 값 찾기' })
  await runTool($, { tool: 'Bash', command: "echo 'a; git push'" })
  await runTool($, { tool: 'Bash', command: 'git push --dry-run' })
  await runTool($, { tool: 'Bash', command: 'git push --help' })

  const lines = await linesOnPane($)
  expect(lines).toContain('  · 조사 둘 중 하나 찾기, 큰 값 찾기')
  expect(lines.join('\n')).not.toContain('· 푸시')
})

test('heredoc 본문의 글은 명령으로 치지 않는다', async ($, on) => {
  standInForEngine(on)

  await submitPrompt($, '고쳐')
  await runTool($, {
    tool: 'Bash',
    command: `python3 - "$MOD" <<'PY'\nprint("a"); git push origin\ngit push origin\ngit commit -m "가짜"\nPY\necho done`,
  })

  const lines = await linesOnPane($)
  expect(lines.join('\n')).not.toContain('· 푸시')
  expect(lines.join('\n')).not.toContain('· 커밋')
})

test('heredoc 뒤에 이어지는 진짜 커밋은 남긴다', async ($, on) => {
  standInForEngine(on)

  await submitPrompt($, '고쳐')
  await runTool($, {
    tool: 'Bash',
    command: `python3 - <<'PY'\nprint("수정")\nPY\ngit add . && git commit -qm "진짜 커밋"`,
  })

  expect(await linesOnPane($)).toContain('  · 커밋 진짜 커밋')
})

test('무언가를 바꿀 수 있는 명령은 조사로 치지 않는다', async ($, on) => {
  standInForEngine(on)

  await submitPrompt($, '해 줘')

  for (const command of [
    'npm test',
    'cat a.txt > b.txt',
    'ls && rm -rf build',
    'find . -name "*.log" | xargs rm',
    "sed -i '' s/a/b/ file.txt",
    'git checkout main',
    'echo "push는 나중에"',
    'cd src && printf done',
  ]) {
    await runTool($, { tool: 'Bash', command, description: '바꾸는 명령' })
  }

  expect((await linesOnPane($)).join('\n')).not.toContain('조사')
})

test('다른 빌드의 검색 도구도 조사로 묶는다', async ($, on) => {
  standInForEngine(on)

  await submitPrompt($, '찾아봐')
  await runTool($, { tool: 'Grep', pattern: 'price' })
  await runTool($, { tool: 'Glob', pattern: '**/*.ts' })

  expect(await linesOnPane($)).toContain('  · 조사 price, **/*.ts')
})

test('실패하거나 거부된 호출은 남기지 않는다', async ($, on) => {
  standInForEngine(on, {
    answerToolCall: call =>
      call.tool === 'Edit'
        ? { result: {}, isError: true }
        : call.tool === 'Write'
          ? { deny: '권한 없음' }
          : undefined,
  })

  await submitPrompt($, '고쳐 줘')
  await runTool($, { tool: 'Edit', file_path: '/a.ts' })
  await runTool($, { tool: 'Write', file_path: '/b.ts' })

  const lines = await linesOnPane($)
  expect(lines.filter(line => !CLOCK_TIME.test(line))).toEqual(['❯ 고쳐 줘'])
})

test('같은 종류가 이어지면 한 줄로 합치고 넘치면 개수로 줄인다', async ($, on) => {
  standInForEngine(on)

  await submitPrompt($, '고쳐 줘')

  for (const name of ['a.ts', 'b.ts', 'a.ts', 'c.ts', 'd.ts']) {
    await runTool($, { tool: 'Edit', file_path: `/repo/${name}` })
  }

  const lines = await linesOnPane($)
  expect(lines).toContain('  · 수정 a.ts, b.ts 외 2개')
  expect(lines.filter(line => line.startsWith('  · 수정'))).toHaveLength(1)
})

test('고치는 도중의 읽기는 수정 줄을 가르지 않는다', async ($, on) => {
  standInForEngine(on)

  await submitPrompt($, '고쳐 줘')
  await runTool($, { tool: 'Read', file_path: '/repo/a.ts' })
  await runTool($, { tool: 'Edit', file_path: '/repo/a.ts' })
  await runTool($, { tool: 'Read', file_path: '/repo/b.ts' })
  await runTool($, { tool: 'Edit', file_path: '/repo/b.ts' })

  const lines = await linesOnPane($)
  expect(lines).toContain('  · 조사 a.ts')
  expect(lines).toContain('  · 수정 a.ts, b.ts')
  expect(lines.filter(line => line.startsWith('  · 조사'))).toHaveLength(1)
})

test('MCP 도구는 서버 이름으로 묶는다', async ($, on) => {
  standInForEngine(on)

  await submitPrompt($, '확인해 줘')
  await runTool($, { tool: 'mcp__plugin_playwright_playwright__browser_navigate' })
  await runTool($, { tool: 'mcp__plugin_playwright_playwright__browser_click' })

  expect(await linesOnPane($)).toContain('  · playwright browser_navigate, browser_click')
})

test('서브에이전트 안의 도구 호출은 남기지 않고 상태만 바꾼다', async ($, on) => {
  const { clock } = standInForEngine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-1' }))

  await submitPrompt($, '조사해 줘')
  await spawnAgent($, '문서 조사')
  await runTool($, { tool: 'Edit', file_path: '/inside-agent.ts' }, 'agent-1')

  let lines = await linesOnPane($)
  expect(lines).toContain('  · 에이전트 ⋯ 문서 조사 · opus')
  expect(lines.join('\n')).not.toContain('inside-agent')

  await finishAgentTurn($, clock, 'agent-1', 'error')
  lines = await linesOnPane($)
  expect(lines).toContain('  · 에이전트 ✗ 1분 40초 문서 조사 · opus')
})

test('백그라운드 작업을 기다리는 에이전트는 끝난 것으로 치지 않는다', async ($, on) => {
  const { clock, agents } = standInForEngine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-1' }))

  await submitPrompt($, '맡겨')
  await spawnAgent($, '기다리는 일')
  agents.push(agentInfo('agent-1', 'waiting'))
  await finishAgentTurn($, clock, 'agent-1')

  expect(await linesOnPane($)).toContain('  · 에이전트 ⋯ 기다리는 일 · opus')

  // 깨어나면 새 줄을 만들지 않고, 기다린 시간까지 합쳐 끝난다.
  await $.agent.spawn({
    tool_use_id: 'tool-wake',
    prompt: '',
    description: '기다리는 일',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
    resume: { agentId: 'agent-1' },
  })
  await clock.advance(AGENT_RUN_MS)
  agents[0] = agentInfo('agent-1', 'completed')
  await $.turn.complete({
    answer: '보고',
    durationMs: 1_000,
    isAborted: false,
    turnId: 'agent-turn',
    agentId: 'agent-1',
    reason: 'answer',
  })
  await clock.advance(AGENT_STATUS_SETTLE_MS)

  const lines = await linesOnPane($)
  expect(lines).toContain('  · 에이전트 ✓ 3분 20초 기다리는 일 · opus')
  expect(lines.filter(line => line.includes('기다리는 일'))).toHaveLength(1)
})

test('끝난 에이전트가 다시 깨어나면 쉰 시간은 빼고 잰다', async ($, on) => {
  const { clock } = standInForEngine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-1' }))

  await submitPrompt($, '맡겨')
  await spawnAgent($, '이어서 할 일')
  await finishAgentTurn($, clock, 'agent-1')
  await clock.advance(3_600_000)
  await $.agent.spawn({
    tool_use_id: 'tool-wake',
    prompt: '하나 더',
    description: '이어서 할 일',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
    resume: { agentId: 'agent-1' },
  })

  expect(await linesOnPane($)).toContain('  · 에이전트 ⋯ 1분 40초 이어서 할 일 · opus')

  await finishAgentTurn($, clock, 'agent-1')

  expect(await linesOnPane($)).toContain('  · 에이전트 ✓ 3분 20초 이어서 할 일 · opus')
})

test('기다리다 멈춘 에이전트는 다음 턴이 없어도 정리한다', async ($, on) => {
  const { clock, agents } = standInForEngine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-1' }))

  await submitPrompt($, '맡겨')
  await spawnAgent($, '멈출 일')
  agents.push(agentInfo('agent-1', 'waiting'))
  await finishAgentTurn($, clock, 'agent-1')
  await completeTurn($, '돌고 있습니다.', 5_000)

  expect(await linesOnPane($)).toContain('⋯ 5초 · 돌고 있습니다.')

  // 멈출 때는 turn.complete가 오지 않는다.
  agents[0] = agentInfo('agent-1', 'killed')
  await clock.advance(5_000)

  const lines = await linesOnPane($)
  expect(lines).toContain('✓ 5초 · 돌고 있습니다.')
  expect(lines.some(line => line.startsWith('  · 에이전트 ✗'))).toBe(true)
})

test('엔진 목록에서 사라진 에이전트는 확인 불가로 끝낸다', async ($, on) => {
  const { clock, agents } = standInForEngine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-1' }))

  await submitPrompt($, '맡겨')
  await spawnAgent($, '사라진 일')
  agents.push(agentInfo('agent-1', 'waiting'))
  await clock.advance(5_000)
  await completeTurn($, '돌고 있습니다.', 5_000)

  agents.length = 0
  await clock.advance(5_000)

  const lines = await linesOnPane($)
  expect(lines).toContain('  · 에이전트 ? 10초 사라진 일 · opus')
  expect(lines).toContain('✓ 5초 · 돌고 있습니다.')
})

test('목록에 올라온 적 없는 에이전트는 끝난 것으로 치지 않는다', async ($, on) => {
  const { clock } = standInForEngine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'workflow-1' }))

  await submitPrompt($, '맡겨')
  await spawnAgent($, '워크플로 일')
  await clock.advance(60_000)

  expect(await linesOnPane($)).toContain('  · 에이전트 ⋯ 워크플로 일 · opus')
})

test('요청마다 자기 에이전트가 끝나면 대기 표시를 푼다', async ($, on) => {
  const { clock } = standInForEngine(on)
  let agentsStarted = 0
  on('agent.spawn', () => {
    agentsStarted += 1

    return { model: 'claude-opus-5-5', agentId: `agent-${agentsStarted}` }
  })

  await submitPrompt($, '첫 일')
  await spawnAgent($, '첫째')
  await completeTurn($, '첫 일을 맡겼습니다.', 5_000)
  await submitPrompt($, '둘째 일')
  await spawnAgent($, '둘째')
  await completeTurn($, '둘째 일을 맡겼습니다.', 5_000)
  await finishAgentTurn($, clock, 'agent-1')

  const lines = await linesOnPane($)
  expect(lines).toContain('✓ 5초 · 첫 일을 맡겼습니다.')
  expect(lines).toContain('⋯ 5초 · 둘째 일을 맡겼습니다.')
})

test('턴 도중 끼어든 글이 있어도 그 요청의 에이전트를 기다린다', async ($, on) => {
  standInForEngine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-1' }))

  await submitPrompt($, '맡겨')
  await spawnAgent($, '오래 걸리는 일')
  await $.prompt.submit({ ...personPrompt('참고로 이것도 봐 줘'), turnId: 'turn-1' })
  await completeTurn($, '맡겼습니다.', 5_000)

  expect(await linesOnPane($)).toContain('⋯ 5초 · 맡겼습니다.')
})

test('다시 연 세션에는 대기 표시가 남지 않는다', async ($, on) => {
  standInForEngine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-1' }))

  await submitPrompt($, '맡겨')
  await spawnAgent($, '돌던 일')
  await completeTurn($, '돌고 있습니다.', 5_000)
  await $.session.end({
    reason: 'clear',
    sessionId: SESSION_ID,
    resume: { id: SESSION_ID },
  } as Parameters<Engine['session']['end']>[0])
  await $.classic.SessionStart({ source: 'resume', session_id: SESSION_ID })

  const lines = await linesOnPane($)
  expect(lines).toContain('  · 에이전트 ? 돌던 일 · opus')
  expect(lines).toContain('✓ 5초 · 돌고 있습니다.')
})

test('강제로 멈춘 에이전트는 실패로 표시한다', async ($, on) => {
  const { clock, agents } = standInForEngine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-1' }))

  await submitPrompt($, '맡겨')
  await spawnAgent($, '멈춘 일')
  agents.push(agentInfo('agent-1', 'killed'))
  await finishAgentTurn($, clock, 'agent-1')

  expect(await linesOnPane($)).toContain('  · 에이전트 ✗ 5초 멈춘 일 · opus')
})

test('세션 안에서 /resume으로 옮기면 그 세션의 로그를 되살린다', async ($, on) => {
  const { store } = standInForEngine(on)

  await submitPrompt($, '이어서 할 일')
  await completeTurn($, '끝')
  await $.session.end({
    reason: 'clear',
    sessionId: SESSION_ID,
    resume: { id: SESSION_ID },
  } as Parameters<Engine['session']['end']>[0])
  await $.classic.SessionStart({ source: 'resume', session_id: SESSION_ID })

  expect(await linesOnPane($)).toContain('❯ 이어서 할 일')

  await submitPrompt($, '새 요청')
  await completeTurn($, '또 끝')

  // 저장본이 새 줄로 덮이면 안 된다.
  const saved = JSON.stringify(store.get(`rows:${SESSION_ID}`))
  expect(saved).toContain('이어서 할 일')
  expect(saved).toContain('새 요청')
})

test('/branch로 갈라지면 원래 세션의 로그를 이어받는다', async ($, on) => {
  standInForEngine(on)

  await submitPrompt($, '갈라지기 전 일')
  await completeTurn($, '끝')
  await $.session.end({
    reason: 'resume',
    sessionId: SESSION_ID,
    resume: { id: SESSION_ID },
  } as Parameters<Engine['session']['end']>[0])
  await $.classic.SessionStart({ source: 'fork', session_id: 'session-branch' })

  expect(await linesOnPane($)).toContain('❯ 갈라지기 전 일')
})

test('자동 실행은 저장하지 않고 요약도 부르지 않는다', async ($, on) => {
  const { clock, store } = standInForEngine(on)
  let calls = 0
  on('model.complete', () => {
    calls += 1

    return { value: { isAnswered: true, text: '요약: 끝\n질문: 없음', usage: NO_USAGE } }
  })

  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await submitPrompt($, LONG_PROMPT)
  await completeTurn($, LONG_ANSWER)
  await $.session.end({
    reason: 'other',
    sessionId: SESSION_ID,
    resume: { id: SESSION_ID },
  } as Parameters<Engine['session']['end']>[0])
  await clock.settle()

  expect(calls).toBe(0)
  expect(store.has('saved-sessions')).toBe(false)
})

test('붙여넣기 태그는 요청 줄에 보이지 않는다', async ($, on) => {
  standInForEngine(on)

  await submitPrompt($, '<pasted_content id="37df">긴 글\n둘째 줄</pasted_content> 정리해 줘')

  expect(await linesOnPane($)).toContain('❯ 긴 글 둘째 줄 정리해 줘')
})

test('커밋 훅이 찍는 줄을 커밋 제목으로 잡지 않는다', async ($, on) => {
  standInForEngine(on, {
    answerToolCall: call =>
      call.tool === 'Bash'
        ? {
            result: {},
            text: '[INFO] Initializing environment for lint\n[main 1a2b3c4] 진짜 제목\n 1 file changed',
          }
        : undefined,
  })

  await submitPrompt($, '커밋해')
  await runTool($, { tool: 'Bash', command: 'git commit -m "진짜 제목"' })

  expect(await linesOnPane($)).toContain('  · 커밋 진짜 제목')
})

test('첫 커밋의 출력도 제목으로 읽는다', async ($, on) => {
  standInForEngine(on, {
    answerToolCall: call =>
      call.tool === 'Bash'
        ? { result: {}, text: '[main (root-commit) bd2df22] 메모 추가' }
        : undefined,
  })

  await submitPrompt($, '커밋해')
  await runTool($, { tool: 'Bash', command: 'git commit --amend' })

  expect(await linesOnPane($)).toContain('  · 커밋 메모 추가')
})

test('에이전트가 띄운 에이전트는 들여 쓴다', async ($, on) => {
  standInForEngine(on)
  let agentsStarted = 0
  on('agent.spawn', () => {
    agentsStarted += 1

    return { model: 'claude-opus-5-5', agentId: `agent-${agentsStarted}` }
  })

  await submitPrompt($, '맡겨')
  await spawnAgent($, '바깥')
  await spawnAgent($, '안쪽', 'agent-1')

  expect(await linesOnPane($)).toContain('    · 에이전트 ⋯ 안쪽 · opus')
})

test('거부된 에이전트는 남기지 않는다', async ($, on) => {
  standInForEngine(on)
  on('agent.spawn', () => ({ deny: '막힘' }))

  await submitPrompt($, '맡겨')
  await spawnAgent($, '막힌 일')

  expect((await linesOnPane($)).join('\n')).not.toContain('막힌 일')
})

test('턴을 시작하지 않는 명령과 /flow는 남기지 않는다', async ($, on) => {
  standInForEngine(on)

  await $.prompt.submit({
    ...personPrompt('/config'),
    command: { name: 'config', args: '' },
  })
  await $.prompt.submit({
    ...personPrompt('/flow'),
    command: { name: 'flow', args: '' },
  })
  await submitPrompt($, '진짜 요청')

  const lines = await linesOnPane($)
  expect(lines).toContain('❯ 진짜 요청')
  expect(lines.join('\n')).not.toContain('config')
  expect(lines.join('\n')).not.toContain('/flow')
})

test('턴을 시작하는 슬래시 명령은 남긴다', async ($, on) => {
  standInForEngine(on)

  await $.prompt.submit({
    ...personPrompt('/review 로그 창'),
    command: { name: 'review', args: '로그 창' },
  })
  await $.turn.start({ text: '펼쳐진 스킬 본문', turnId: 'turn-1' })

  expect(await linesOnPane($)).toContain('❯ /review 로그 창')
})

test('백그라운드 알림과 숨은 프롬프트는 요청으로 남기지 않는다', async ($, on) => {
  standInForEngine(on)

  await $.prompt.submit({
    text: '<task-notification>끝남</task-notification>',
    wait: false,
    isMeta: true,
    origin: { kind: 'task-notification' },
  })
  await $.turn.start({ text: '', turnId: 'turn-1' })

  expect((await linesOnPane($)).join('\n')).not.toContain('task-notification')
})

test('돌고 있는 턴에 끼어든 글은 바로 남긴다', async ($, on) => {
  standInForEngine(on)

  await $.prompt.submit({ ...personPrompt('그건 빼 줘'), turnId: 'turn-1' })

  expect(await linesOnPane($)).toContain('❯ 그건 빼 줘')
})

test('턴이 중단되면 중단으로 끝난다', async ($, on) => {
  standInForEngine(on)

  await submitPrompt($, '돌려 줘')
  await $.turn.complete({
    answer: '',
    durationMs: 3_000,
    isAborted: true,
    turnId: 'turn',
    reason: 'aborted',
  })

  expect(await linesOnPane($)).toContain('■ 3초')
})

test('백그라운드 에이전트가 돌고 있으면 턴이 끝나도 완료로 표시하지 않는다', async ($, on) => {
  const { clock } = standInForEngine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-1' }))

  await submitPrompt($, '맡겨')
  await spawnAgent($, '오래 걸리는 일')
  await completeTurn($, '에이전트가 조사 중입니다.', 5_000)

  expect(await linesOnPane($)).toContain('⋯ 5초 · 에이전트가 조사 중입니다.')

  await finishAgentTurn($, clock, 'agent-1')

  // 기다리던 에이전트가 끝나면 앞선 줄도 더 이상 대기 중이 아니다.
  expect(await linesOnPane($)).toContain('✓ 5초 · 에이전트가 조사 중입니다.')

  await completeTurn($, '조사가 끝났습니다.', 2_000)

  expect(await linesOnPane($)).toContain('✓ 2초 · 조사가 끝났습니다.')
})

test('앞선 요청의 에이전트가 돌아도 상관없는 답은 완료로 표시한다', async ($, on) => {
  standInForEngine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-1' }))

  await submitPrompt($, '검수 맡겨')
  await spawnAgent($, '재검수')
  await completeTurn($, '재검수를 돌리고 있습니다.', 5_000)
  await submitPrompt($, '다른 질문')
  await completeTurn($, '답입니다.', 2_000)

  const lines = await linesOnPane($)
  expect(lines).toContain('⋯ 5초 · 재검수를 돌리고 있습니다.')
  expect(lines).toContain('✓ 2초 · 답입니다.')
})

test('에이전트가 하나라도 남아 있으면 대기 표시를 유지한다', async ($, on) => {
  const { clock } = standInForEngine(on)
  let agentsStarted = 0
  on('agent.spawn', () => {
    agentsStarted += 1

    return { model: 'claude-opus-5-5', agentId: `agent-${agentsStarted}` }
  })

  await submitPrompt($, '맡겨')
  await spawnAgent($, '첫째')
  await spawnAgent($, '둘째')
  await completeTurn($, '둘 다 돌고 있습니다.', 5_000)
  await finishAgentTurn($, clock, 'agent-1')

  expect(await linesOnPane($)).toContain('⋯ 5초 · 둘 다 돌고 있습니다.')

  await finishAgentTurn($, clock, 'agent-2')

  expect(await linesOnPane($)).toContain('✓ 5초 · 둘 다 돌고 있습니다.')
})

test('중간 설명을 끄면 남기지 않는다', { options: { showNarration: false } }, async ($, on) => {
  standInForEngine(on)
  mock.session(on)

  await $.session.append({
    message: {
      type: 'assistant',
      role: 'assistant',
      content: [{ type: 'text', text: '먼저 설정을 확인할게요.' }],
    },
    door: 'response',
    origin: { kind: 'model', model: 'claude-opus-5-5' },
    uuid: 'row-1',
  })

  expect((await linesOnPane($)).join('\n')).not.toContain('확인할게요')
})

const narrate = ($: Engine, text: string, agentId?: string) =>
  $.session.append({
    message: {
      type: 'assistant',
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
    door: 'response',
    origin: { kind: 'model', model: 'claude-opus-5-5' },
    uuid: `row-${text}`,
    agentId,
  })

test('기본 설정에서 중간 설명을 남기되 최종 답과 겹치지 않는다', async ($, on) => {
  standInForEngine(on)
  mock.session(on)

  await submitPrompt($, '해 줘')
  await narrate($, '먼저 설정을 확인할게요.\n\n둘째 문단')
  await narrate($, '속으로 하는 말', 'agent-1')
  await narrate($, '끝났습니다.')
  await completeTurn($, '끝났습니다.')

  const lines = await linesOnPane($)
  expect(lines).toContain('  · 먼저 설정을 확인할게요.')
  expect(lines).toContain('✓ 1분 5초 · 끝났습니다.')
  expect(lines.join('\n')).not.toContain('속으로')
  expect(lines.filter(line => line.includes('끝났습니다'))).toHaveLength(1)
})

test('다시 연 세션은 저장된 로그를 되살린다', async ($, on) => {
  standInForEngine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-1' }))

  await submitPrompt($, '이어서 할 일')
  await spawnAgent($, '오래 도는 일')
  await completeTurn($, '끝')
  await $.session.end({
    reason: 'clear',
    sessionId: SESSION_ID,
    resume: { id: SESSION_ID },
  } as Parameters<Engine['session']['end']>[0])

  expect((await linesOnPane($)).join('\n')).not.toContain('이어서 할 일')

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const lines = await linesOnPane($)
  expect(lines).toContain('❯ 이어서 할 일')
  // 프로세스가 바뀌면 에이전트의 끝을 알 수 없다. 실행 중으로 남기지 않는다.
  expect(lines).toContain('  · 에이전트 ? 오래 도는 일 · opus')
})

test('저장 줄 수가 넘치면 오래된 세션부터 밀려난다', async ($, on) => {
  const oldSessions = Array.from({ length: 12 }, (_, index) => ({
    id: `old-${index}`,
    rowCount: 500,
  }))
  const { store } = standInForEngine(on, {
    sessionId: 'session-new',
    stored: { 'saved-sessions': oldSessions, 'rows:old-0': [], 'rows:old-1': [] },
  })

  await submitPrompt($, '요청')
  await completeTurn($, '끝')

  expect(store.has('rows:old-0')).toBe(false)
  expect(store.has('rows:old-1')).toBe(true)
  const kept = store.get('saved-sessions') as { id: string }[]
  expect(kept).toHaveLength(12)
  expect(kept.at(-1)?.id).toBe('session-new')
})

test('짧은 세션은 많아도 밀려나지 않는다', async ($, on) => {
  const shortSessions = Array.from({ length: 200 }, (_, index) => ({
    id: `short-${index}`,
    rowCount: 10,
  }))
  const { store } = standInForEngine(on, {
    sessionId: 'session-new',
    stored: { 'saved-sessions': shortSessions },
  })

  await submitPrompt($, '요청')
  await completeTurn($, '끝')

  expect(store.get('saved-sessions')).toHaveLength(201)
})

test('폭이 모자라 대기 중인 창은 /flow가 닫지 않고 연다', async ($, on) => {
  const { store } = standInForEngine(on, { stored: { 'pane-folders': [PROJECT] } })
  const open = trackPanes(on)
  open.push({
    id: PANE_ID,
    title: '세션 흐름',
    isShown: false,
    isFocused: false,
    isPlaced: false,
  })

  await runFlowCommand($)

  expect(open).toHaveLength(2)
  expect(store.get('pane-folders')).toEqual([PROJECT])
})

test('/flow는 창을 열고 다시 치면 닫는다', async ($, on) => {
  standInForEngine(on)
  const open = trackPanes(on)

  expect(await runFlowCommand($)).toEqual({})
  expect(open.map(pane => pane.id)).toEqual([PANE_ID])
  await runFlowCommand($)
  expect(open).toEqual([])
})

/** 창 열기와 닫기를 엔진 대신 받아, 지금 열린 창을 돌려준다. */
function trackPanes(on: On): UiPane[] {
  const open: UiPane[] = []
  on('ui.panes', () => ({ value: open }))
  on('ui.open', (_, e) => {
    open.push({
      id: e.id,
      title: e.title ?? e.id,
      isShown: true,
      isFocused: false,
      isPlaced: true,
    })

    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    open.length = 0

    return { value: undefined }
  })

  return open
}

const runFlowCommand = ($: Engine) =>
  $.command.run({
    command: 'flow',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 130 },
  })

/** 실제 터미널의 순서대로 띠를 먼저 그리고 시작 처리를 끝낸 뒤 다시 그린다. */
async function startSessionAndDraw(
  $: Engine,
  { isFullscreen = true, isInteractive = true } = {},
) {
  const draw = async () => {
    const ui = await $.ui.mount({
      plugin: 'session-flow',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: bandProps,
      viewport: { columns: 130, rows: 40, isFullscreen },
    })
    await ui.unmount()
  }

  await draw()
  await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive })
  await draw()
}

test('창을 열어 둔 폴더는 다음 세션에서 자동으로 열린다', async ($, on) => {
  standInForEngine(on)
  const open = trackPanes(on)
  let redrawRequests = 0
  on('ui.invalidate', () => {
    redrawRequests += 1

    return { value: undefined }
  })

  await runFlowCommand($)
  open.length = 0
  await startSessionAndDraw($)

  expect(open.map(pane => pane.id)).toEqual([PANE_ID])
  // 첫 그리기가 시작 처리보다 먼저 끝나므로 다시 그리기 요청이 있어야 실제로 열린다.
  expect(redrawRequests).toBe(1)
})

test('/flow를 쓴 적 없는 폴더는 자동으로 열리지 않는다', async ($, on) => {
  standInForEngine(on)
  const open = trackPanes(on)

  await startSessionAndDraw($)

  expect(open).toEqual([])
})

test('창을 닫은 폴더는 다음부터 자동으로 열리지 않는다', async ($, on) => {
  const { store } = standInForEngine(on, {
    stored: { 'pane-folders': ['/projects/other'] },
  })
  const open = trackPanes(on)

  await runFlowCommand($)
  expect(store.get('pane-folders')).toEqual(['/projects/other', PROJECT])

  await runFlowCommand($)
  expect(store.get('pane-folders')).toEqual(['/projects/other'])

  await startSessionAndDraw($)

  expect(open).toEqual([])
})

test('일반 화면에서는 자동으로 열지 않는다', async ($, on) => {
  standInForEngine(on, { stored: { 'pane-folders': [PROJECT] } })
  const open = trackPanes(on)

  await startSessionAndDraw($, { isFullscreen: false })

  expect(open).toEqual([])
})

test('자동 실행에서는 열지 않는다', async ($, on) => {
  standInForEngine(on, { stored: { 'pane-folders': [PROJECT] } })
  const open = trackPanes(on)

  await startSessionAndDraw($, { isInteractive: false })

  expect(open).toEqual([])
})

test('자동으로 여는 일은 세션 시작에 한 번뿐이다', async ($, on) => {
  standInForEngine(on, { stored: { 'pane-folders': [PROJECT] } })
  const open = trackPanes(on)

  await startSessionAndDraw($)
  open.length = 0

  const ui = await $.ui.mount({
    plugin: 'session-flow',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: bandProps,
    viewport: { columns: 130, rows: 40, isFullscreen: true },
  })
  await ui.unmount()

  expect(open).toEqual([])
})

test('기억하는 폴더 수는 묶여 있다', async ($, on) => {
  const stale = Array.from({ length: 50 }, (_, index) => `/old/${index}`)
  const { store } = standInForEngine(on, { stored: { 'pane-folders': stale } })
  trackPanes(on)

  await runFlowCommand($)

  const kept = store.get('pane-folders') as string[]
  expect(kept).toHaveLength(50)
  expect(kept.at(-1)).toBe(PROJECT)
})

test('네 표면 모두에서 그려지고 좁으면 시각을 뺀다', async ($, on) => {
  standInForEngine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-1' }))

  await submitPrompt($, '요청')
  await runTool($, { tool: 'Edit', file_path: '/a.ts' })
  await spawnAgent($, '일')
  await completeTurn($, '끝')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const wide = await linesOnPane($, surface, WIDE_COLUMNS)
    expect(wide).toContain('❯ 요청')
    expect(wide.some(line => CLOCK_TIME.test(line))).toBe(true)

    const narrow = await linesOnPane($, surface, 30)
    expect(narrow.some(line => CLOCK_TIME.test(line))).toBe(false)
  }
})

test('기록이 없을 때는 안내를 보인다', async $ => {
  expect(await linesOnPane($)).toEqual([
    '아직 기록이 없어요. 일을 시키면 여기에 쌓입니다.',
  ])
})

test('이전 버전이 저장한 값은 받지 않는다', async ($, on) => {
  on('state.get', () => ({
    value: { value: [{ kind: 'old' }], version: 1 },
  }))

  expect(await linesOnPane($)).toEqual([
    '아직 기록이 없어요. 일을 시키면 여기에 쌓입니다.',
  ])
})

const LONG_PROMPT =
  '클로드 모드 기능 이번에 출시되었잖아. 이 기능 사용해서 만들고 싶은것 중에 하나가 세션 진행 상황 로그를 볼수 있는 기능이야.'

test('기본 설정에서 긴 요청을 지정한 모델로 줄인다', async ($, on) => {
  const { clock } = standInForEngine(on)
  const calls: { model: string; effort?: string }[] = []
  on('model.complete', (_, e) => {
    calls.push({ model: e.model, effort: e.effort })

    return { value: { isAnswered: true, text: '세션 로그 모드 만들기', usage: NO_USAGE } }
  })

  await submitPrompt($, LONG_PROMPT)
  await clock.settle()

  expect(await linesOnPane($)).toContain('❯ 세션 로그 모드 만들기')
  expect(calls).toEqual([{ model: 'claude-haiku-5-5', effort: 'low' }])
})

test('모델이 단 머리말은 걷어 낸다', async ($, on) => {
  const { clock } = standInForEngine(on)
  on('model.complete', () => ({
    value: { isAnswered: true, text: '로그용 한 줄: 세션 로그 모드 만들기', usage: NO_USAGE },
  }))

  await submitPrompt($, LONG_PROMPT)
  await clock.settle()

  expect(await linesOnPane($)).toContain('❯ 세션 로그 모드 만들기')
})

test('요약이 실패해도 원문이 남는다', async ($, on) => {
  const { clock } = standInForEngine(on)
  on('model.complete', () => ({
    value: { isAnswered: false, reason: 'empty-reply', usage: NO_USAGE },
  }))
  on('ui.log', () => ({ value: undefined }))

  await submitPrompt($, LONG_PROMPT)
  await clock.settle()

  expect((await linesOnPane($)).join('\n')).toContain('클로드 모드 기능')
})

test('짧은 글은 모델을 부르지 않는다', async ($, on) => {
  const { clock } = standInForEngine(on)
  let calls = 0
  on('model.complete', () => {
    calls += 1

    return { value: { isAnswered: true, text: '요약', usage: NO_USAGE } }
  })

  await submitPrompt($, '짧은 요청')
  await completeTurn($, '짧은 답')
  await clock.settle()

  expect(calls).toBe(0)
})

test('요약을 끄면 긴 글도 모델을 부르지 않는다', { options: { summarize: false } }, async ($, on) => {
  const { clock } = standInForEngine(on)
  let calls = 0
  on('model.complete', () => {
    calls += 1

    return { value: { isAnswered: true, text: '요약', usage: NO_USAGE } }
  })

  await submitPrompt($, LONG_PROMPT)
  await clock.settle()

  expect(calls).toBe(0)
})

const LONG_ANSWER =
  '로그 모드를 만들었고 테스트도 통과했습니다. 이제 모든 세션에서 쓸 수 있게 설치하는 일만 남았습니다. 설치할까요?'

const bandProps = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 8,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 8 },
  view: {},
} as const

async function mountBand($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  return $.ui.mount({
    plugin: 'session-flow',
    surface,
    component: 'AbovePrompt',
    props: bandProps,
  })
}

async function bandLines($: Engine): Promise<string[]> {
  const ui = await mountBand($)
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()

  return texts.flatMap(found => (found.text === undefined ? [] : [found.text]))
}

function answerDigest(on: On, text: string) {
  on('model.complete', () => ({
    value: { isAnswered: true, text, usage: NO_USAGE },
  }))
}

test('답을 기다리는 질문은 띠에 고정되고 로그에도 남는다', async ($, on) => {
  const { clock } = standInForEngine(on)
  answerDigest(on, '요약: 로그 모드 완성\n질문: 모든 세션에 설치할지 결정 필요')

  await submitPrompt($, '만들어 줘')
  await completeTurn($, LONG_ANSWER)
  await clock.settle()

  expect(await bandLines($)).toContain('? 모든 세션에 설치할지 결정 필요')
  const lines = await linesOnPane($)
  expect(lines).toContain('✓ 1분 5초 · 로그 모드 완성')
  expect(lines).toContain('  ? 모든 세션에 설치할지 결정 필요')
})

test('질문이 없으면 띠를 그리지 않는다', async ($, on) => {
  const { clock } = standInForEngine(on)
  answerDigest(on, '요약: 로그 모드 완성\n질문: 없음')

  await submitPrompt($, '만들어 줘')
  await completeTurn($, LONG_ANSWER)
  await clock.settle()

  expect(await bandLines($)).toEqual([ENGINE_BAND])
})

test('따옴표로 감싼 없음도 질문이 아니다', async ($, on) => {
  const { clock } = standInForEngine(on)
  answerDigest(on, "요약: 로그 모드 완성\n질문: '없음'")

  await submitPrompt($, '만들어 줘')
  await completeTurn($, LONG_ANSWER)
  await clock.settle()

  expect(await bandLines($)).toEqual([ENGINE_BAND])
})

test('모델이 형식을 어기면 앞 문장을 두고 물음표로 찾는다', async ($, on) => {
  const { clock } = standInForEngine(on)
  answerDigest(on, '<summary>요약</summary><question>질문</question>')

  await submitPrompt($, '만들어 줘')
  await completeTurn($, LONG_ANSWER)
  await clock.settle()

  const lines = await linesOnPane($)
  expect(lines).toContain('✓ 1분 5초 · 로그 모드를 만들었고 테스트도 통과했습니다.')
  expect(lines.join('\n')).not.toContain('summary')
  expect(await bandLines($)).toContain('? 설치할까요?')
})

test('요약을 기다리는 사이 /clear하면 지난 질문을 새 세션에 올리지 않는다', async ($, on) => {
  const { clock } = standInForEngine(on)
  answerDigest(on, '요약: 완성\n질문: 설치할까요')

  await submitPrompt($, '만들어 줘')
  await completeTurn($, LONG_ANSWER)
  await $.session.end({
    reason: 'clear',
    sessionId: SESSION_ID,
    resume: { id: SESSION_ID },
  } as Parameters<Engine['session']['end']>[0])
  await clock.settle()

  expect(await bandLines($)).toEqual([ENGINE_BAND])
  expect((await linesOnPane($)).join('\n')).not.toContain('설치할까요')
})

test('다음 요청을 보내면 띠에서 내려가고 로그에는 남는다', async ($, on) => {
  const { clock } = standInForEngine(on)
  answerDigest(on, '요약: 완성\n질문: 설치할까요')

  await submitPrompt($, '만들어 줘')
  await completeTurn($, LONG_ANSWER)
  await clock.settle()
  await submitPrompt($, '다음 일')

  expect(await bandLines($)).not.toContain('? 설치할까요')
  expect(await linesOnPane($)).toContain('  ? 설치할까요')
})

test('요약이 끝나기 전에 답을 보냈으면 띠에 올리지 않고 제자리에 남긴다', async ($, on) => {
  const { clock } = standInForEngine(on)
  answerDigest(on, '요약: 완성\n질문: 설치할까요')

  await submitPrompt($, '만들어 줘')
  await completeTurn($, LONG_ANSWER)
  await submitPrompt($, '그대로 둬')
  await clock.settle()

  expect(await bandLines($)).not.toContain('? 설치할까요')

  const lines = await linesOnPane($)
  const questionIndex = lines.indexOf('  ? 설치할까요')
  expect(questionIndex).toBeGreaterThan(-1)
  expect(questionIndex).toBeLessThan(lines.indexOf('❯ 그대로 둬'))
})

test('턴을 시작하지 않는 명령은 질문을 내리지 않는다', async ($, on) => {
  const { clock } = standInForEngine(on)
  answerDigest(on, '요약: 완성\n질문: 설치할까요')

  await submitPrompt($, '만들어 줘')
  await completeTurn($, LONG_ANSWER)
  await clock.settle()
  await $.prompt.submit({
    ...personPrompt('/config'),
    command: { name: 'config', args: '' },
  })
  await $.prompt.submit({
    ...personPrompt('/flow'),
    command: { name: 'flow', args: '' },
  })

  expect(await bandLines($)).toContain('? 설치할까요')
})

test('백그라운드 작업으로 턴이 이어져도 질문은 띠에 남는다', async ($, on) => {
  const { clock } = standInForEngine(on)
  let digests = 0
  on('model.complete', () => {
    digests += 1

    return {
      value: {
        isAnswered: true,
        text: digests === 1 ? '요약: 완성\n질문: 설치할까요' : '요약: 조사 끝\n질문: 없음',
        usage: NO_USAGE,
      },
    }
  })

  await submitPrompt($, '만들어 줘')
  await completeTurn($, LONG_ANSWER)
  await clock.settle()
  await $.prompt.submit({
    text: '<task-notification>끝남</task-notification>',
    wait: false,
    isMeta: true,
    origin: { kind: 'task-notification' },
  })
  await $.turn.start({ text: '', turnId: 'turn-2' })
  await completeTurn($, '백그라운드 조사가 끝났고 결과는 예상과 같았습니다. 추가로 고칠 부분은 없었습니다.')
  await clock.settle()

  expect(await bandLines($)).toContain('? 설치할까요')
})

test('확인 버튼을 누르면 띠에서 내려간다', async ($, on) => {
  const { clock } = standInForEngine(on)
  answerDigest(on, '요약: 완성\n질문: 설치할까요')

  await submitPrompt($, '만들어 줘')
  await completeTurn($, LONG_ANSWER)
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountBand($, surface)
    expect(await ui.find({ type: 'Text', text: /설치할까요/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await mountBand($)
  await ui.press({ key: 'seen' })
  await ui.unmount()

  expect(await bandLines($)).not.toContain('? 설치할까요')
})

test('같은 질문을 또 물어도 한 번만 남긴다', async ($, on) => {
  const { clock } = standInForEngine(on)
  answerDigest(on, '요약: 완성\n질문: 설치할까요')

  await submitPrompt($, '만들어 줘')
  await completeTurn($, LONG_ANSWER)
  await completeTurn($, LONG_ANSWER)
  await clock.settle()

  expect((await bandLines($)).filter(line => line === '? 설치할까요')).toHaveLength(1)
})

test('질문이 넘치면 최근 것만 띠에 보인다', async ($, on) => {
  const { clock } = standInForEngine(on)
  let digests = 0
  on('model.complete', () => {
    digests += 1

    return {
      value: { isAnswered: true, text: `요약: 완성\n질문: 질문 ${digests}`, usage: NO_USAGE },
    }
  })

  await submitPrompt($, '만들어 줘')

  for (let turn = 0; turn < 4; turn += 1) {
    await completeTurn($, LONG_ANSWER)
    await clock.settle()
  }

  const lines = await bandLines($)
  expect(lines).toContain('? 질문 4')
  expect(lines).not.toContain('? 질문 1')
  expect(lines).toContain('외 1개는 /flow에서 볼 수 있어요')
})

test('짧은 답의 질문은 모델 없이 찾는다', async ($, on) => {
  const { clock } = standInForEngine(on)
  let calls = 0
  on('model.complete', () => {
    calls += 1

    return { value: { isAnswered: true, text: '요약: 끝', usage: NO_USAGE } }
  })

  await submitPrompt($, '해 줘')
  await completeTurn($, '끝났습니다. **설치할까요?**')
  await clock.settle()

  expect(calls).toBe(0)
  expect(await bandLines($)).toContain('? 설치할까요?')
})

test('요약이 실패하면 물음표 문장을 질문으로 쓴다', async ($, on) => {
  const { clock } = standInForEngine(on)
  on('model.complete', () => ({
    value: { isAnswered: false, reason: 'empty-reply', usage: NO_USAGE },
  }))
  on('ui.log', () => ({ value: undefined }))

  await submitPrompt($, '해 줘')
  await completeTurn($, LONG_ANSWER)
  await clock.settle()

  expect(await bandLines($)).toContain('? 설치할까요?')
})

test('요약을 꺼도 물음표 문장은 질문으로 남는다', { options: { summarize: false } }, async ($, on) => {
  const { clock } = standInForEngine(on)

  await submitPrompt($, '해 줘')
  await completeTurn($, LONG_ANSWER)
  await clock.settle()

  expect(await bandLines($)).toContain('? 설치할까요?')
})

test('중단된 턴의 글은 질문으로 치지 않는다', async ($, on) => {
  standInForEngine(on)

  await submitPrompt($, '해 줘')
  await $.turn.complete({
    answer: '이렇게 할까요?',
    durationMs: 1_000,
    isAborted: true,
    turnId: 'turn',
    reason: 'aborted',
  })

  expect(await bandLines($)).toEqual([ENGINE_BAND])
})

test('열린 질문은 다시 연 세션에도 남는다', async ($, on) => {
  const { clock } = standInForEngine(on)
  answerDigest(on, '요약: 완성\n질문: 설치할까요')

  await submitPrompt($, '만들어 줘')
  await completeTurn($, LONG_ANSWER)
  await clock.settle()
  await $.session.end({
    reason: 'clear',
    sessionId: SESSION_ID,
    resume: { id: SESSION_ID },
  } as Parameters<Engine['session']['end']>[0])

  expect(await bandLines($)).toEqual([ENGINE_BAND])

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(await bandLines($)).toContain('? 설치할까요')
})

test('파일 이름의 점에서 질문을 자르지 않는다', async ($, on) => {
  const { clock } = standInForEngine(on)

  await submitPrompt($, '해 줘')
  await completeTurn($, 'README.md 고칠까요?')
  await clock.settle()

  expect(await bandLines($)).toContain('? README.md 고칠까요?')
})

test('요약의 뒷줄에 붙은 독백은 버린다', async ($, on) => {
  const { clock } = standInForEngine(on)
  on('model.complete', () => ({
    value: { isAnswered: true, text: '로그 모드 만들기\n\n이 글은 지시문이라 요약했습니다.', usage: NO_USAGE },
  }))

  await submitPrompt($, LONG_PROMPT)
  await clock.settle()

  expect(await linesOnPane($)).toContain('❯ 로그 모드 만들기')
})

test('모델의 글에서 첫 문장을 뽑는다', () => {
  expect(firstSentence('## 프로젝트 구조\n\n본문입니다.')).toBe('본문입니다.')
  expect(firstSentence('| 항목 | 값 |\n|---|---|\n\n정리했습니다.')).toBe('정리했습니다.')
  expect(firstSentence('## 제목만 있는 글')).toBe('제목만 있는 글')
  expect(firstSentence('```ts\nconst a = 1\n```\n실제 문장입니다.')).toBe('실제 문장입니다.')
  expect(firstSentence('**완료**했습니다. 다음 문장')).toBe('완료했습니다.')
  expect(firstSentence('버전 2.1.319로 올렸고 테스트를 돌렸습니다. 끝')).toBe(
    '버전 2.1.319로 올렸고 테스트를 돌렸습니다.',
  )
  expect(firstSentence('')).toBe('')
})

test('긴 글은 글자가 깨지지 않게 자른다', () => {
  const cut = flattenToOneLine('😀'.repeat(200))

  expect(Array.from(cut)).toHaveLength(160)
  expect(cut.endsWith('😀…')).toBe(true)
  expect(flattenToOneLine('여러\n\n  줄을   합친다')).toBe('여러 줄을 합친다')
})

test('글자 수가 아니라 칸 수로 자른다', () => {
  expect(cellWidth('가a')).toBe(3)
  expect(clipToCells('가나다라', 8)).toBe('가나다라')
  expect(clipToCells('가나다라', 7)).toBe('가나다…')
  expect(clipToCells('abcdef', 4)).toBe('abc…')
})

test('긴 글은 두 줄 분량까지 보이고 그 뒤는 잘린다', async ($, on) => {
  standInForEngine(on, {})

  const longRequest = '가나다라마바사아자차카타파하'.repeat(10)
  await submitPrompt($, longRequest)

  const [line = ''] = await linesOnPane($, 'terminal', 30)
  expect(line.endsWith('…')).toBe(true)
  expect(cellWidth(line)).toBeLessThanOrEqual(2 + 28 * 2)
  expect(cellWidth(line)).toBeGreaterThan(28)
})

test('걸린 시간을 읽기 쉽게 쓴다', () => {
  expect(formatDuration(4_000)).toBe('4초')
  expect(formatDuration(65_000)).toBe('1분 5초')
  expect(formatDuration(120_000)).toBe('2분')
  expect(formatDuration(780_000)).toBe('13분')
  expect(formatDuration(7_500_000)).toBe('2시간 5분')
})
