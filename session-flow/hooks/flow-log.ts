import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type {
  AgentRow,
  AgentStatus,
  FlowRow,
  QuestionRow,
  RowStamp,
  TurnOutcome,
} from '../types'
import { EDIT_LABEL, RESEARCH_LABEL } from './tool-activity'
import type { ToolActivity } from './tool-activity'

/** 세션 하나에 보관하는 줄 수. 넘치면 오래된 줄부터 버린다. */
const MAX_KEPT_ROWS = 500

// 줄의 필드가 바뀌면 태그도 바꾼다. 이전 버전이 저장한 값은 리로드 뒤에도 남기 때문이다.
const flowRows = atom({ plugin: 'session-flow', key: 'rows' } as const, [], {
  shape: 'rows-4',
})

let rowsMade = 0

async function stampNow($: EngineInterface): Promise<RowStamp> {
  const at = await $.clock.now()
  rowsMade += 1

  return { id: `${at}-${rowsMade}`, at }
}

function keepRecent(rows: FlowRow[]): FlowRow[] {
  return rows.slice(-MAX_KEPT_ROWS)
}

/** 그리는 중에 부르면 그 창이 값 변경을 구독한다. */
export async function readRows($: EngineInterface): Promise<readonly FlowRow[]> {
  return read($, flowRows)
}

async function appendRow($: EngineInterface, row: FlowRow): Promise<string> {
  await update($, flowRows, rows => keepRecent([...rows, row]))

  return row.id
}

export async function addRequest(
  $: EngineInterface,
  text: string,
  isInterjection: boolean,
): Promise<string> {
  return appendRow($, {
    ...(await stampNow($)),
    kind: 'request',
    text,
    isInterjection,
  })
}

export async function addNarration(
  $: EngineInterface,
  text: string,
): Promise<void> {
  await appendRow($, { ...(await stampNow($)), kind: 'narration', text })
}

export async function addNotice(
  $: EngineInterface,
  text: string,
): Promise<void> {
  await appendRow($, { ...(await stampNow($)), kind: 'notice', text })
}

/**
 * 직전 줄이 같은 종류면 그 줄에 합치고, 이미 있는 항목이면 그대로 둔다.
 * 고치는 도중의 읽기는 수정을 위한 확인일 뿐이라 새 줄을 만들지 않는다.
 * 그러지 않으면 읽기와 수정이 번갈아 나올 때마다 줄이 갈라진다.
 */
export function mergeActivity(
  rows: readonly FlowRow[],
  activity: ToolActivity,
  stamp: RowStamp,
): FlowRow[] {
  const last = rows.at(-1)
  const isReadWhileEditing =
    activity.label === RESEARCH_LABEL &&
    last?.kind === 'activity' &&
    last.label === EDIT_LABEL

  if (isReadWhileEditing) {
    return [...rows]
  }

  if (last?.kind !== 'activity' || last.label !== activity.label) {
    return [
      ...rows,
      {
        ...stamp,
        kind: 'activity',
        label: activity.label,
        items: [activity.item],
      },
    ]
  }

  if (last.items.includes(activity.item)) {
    return [...rows]
  }

  return [
    ...rows.slice(0, -1),
    { ...last, items: [...last.items, activity.item] },
  ]
}

export async function addActivity(
  $: EngineInterface,
  activity: ToolActivity,
): Promise<void> {
  const stamp = await stampNow($)
  await update($, flowRows, rows =>
    keepRecent(mergeActivity(rows, activity, stamp)),
  )
}

function findLastAgent(
  rows: readonly FlowRow[],
  agentId: string,
): AgentRow | undefined {
  return rows
    .filter((row): row is AgentRow => row.kind === 'agent')
    .findLast(row => row.agentId === agentId)
}

function replaceRow(
  rows: readonly FlowRow[],
  target: AgentRow,
  replacement: AgentRow,
): FlowRow[] {
  return rows.map(row => (row === target ? replacement : row))
}

type StartedAgent = Pick<AgentRow, 'description' | 'model' | 'agentId'> & {
  parentAgentId?: string
}

export async function addAgent(
  $: EngineInterface,
  { parentAgentId, ...agent }: StartedAgent,
): Promise<void> {
  const stamp = await stampNow($)
  await update($, flowRows, rows => {
    const parent =
      parentAgentId === undefined
        ? undefined
        : findLastAgent(rows, parentAgentId)
    const row: AgentRow = {
      ...stamp,
      ...agent,
      kind: 'agent',
      depth: parent === undefined ? 0 : parent.depth + 1,
      runStartedAt: stamp.at,
      // 끝을 알릴 id가 없는 원격 에이전트는 영원히 실행 중으로 보이면 안 된다.
      status: agent.agentId === undefined ? 'unknown' : 'running',
    }

    return keepRecent([...rows, row])
  })
}

function hasRunningAgent(rows: readonly FlowRow[]): boolean {
  return rows.some(row => row.kind === 'agent' && row.status === 'running')
}

/** 새 일을 시작하는 요청. 끼어든 글은 앞선 요청의 일이 이어지는 것이다. */
function startsNewRequest(row: FlowRow): boolean {
  return row.kind === 'request' && !row.isInterjection
}

/** 각 줄이 몇 번째 요청에 속하는지 줄 순서대로 돌려준다. */
function requestNumbers(rows: readonly FlowRow[]): number[] {
  let current = 0

  return rows.map(row => {
    current += startsNewRequest(row) ? 1 : 0

    return current
  })
}

/** 자기 요청의 에이전트가 모두 끝난 줄의 ⋯ 표시를 푼다. 남아 있으면 아직 도는 것처럼 보인다. */
function settleWaitingTurns(rows: readonly FlowRow[]): FlowRow[] {
  const numbers = requestNumbers(rows)
  const busyRequests = new Set(
    numbers.filter((_, index) => {
      const row = rows[index]

      return row?.kind === 'agent' && row.status === 'running'
    }),
  )

  return rows.map((row, index) =>
    row.kind === 'turn-end' &&
    row.outcome === 'waiting' &&
    !busyRequests.has(numbers[index] ?? 0)
      ? { ...row, outcome: 'answered' }
      : row,
  )
}

/** 끝을 알릴 이벤트를 기다리는 줄의 에이전트 id. */
export function runningAgentIds(rows: readonly FlowRow[]): string[] {
  return rows.flatMap(row =>
    row.kind === 'agent' && row.status === 'running' && row.agentId !== undefined
      ? [row.agentId]
      : [],
  )
}

/** 깨어난 에이전트는 새 줄을 만들지 않고 원래 줄을 잇는다. 줄을 찾았으면 true. */
export async function reopenAgent(
  $: EngineInterface,
  agentId: string,
): Promise<boolean> {
  const now = await $.clock.now()
  let isFound = false

  await update($, flowRows, rows => {
    const agent = findLastAgent(rows, agentId)
    isFound = agent !== undefined

    return agent === undefined || agent.status === 'running'
      ? rows
      : replaceRow(rows, agent, {
          ...agent,
          status: 'running',
          runStartedAt: now,
        })
  })

  return isFound
}

export async function finishAgent(
  $: EngineInterface,
  agentId: string,
  status: Exclude<AgentStatus, 'running'>,
): Promise<void> {
  const now = await $.clock.now()

  await update($, flowRows, rows => {
    const agent = findLastAgent(rows, agentId)

    if (agent?.status !== 'running') {
      return rows
    }

    return settleWaitingTurns(
      replaceRow(rows, agent, {
        ...agent,
        status,
        durationMs: (agent.durationMs ?? 0) + now - agent.runStartedAt,
      }),
    )
  })
}

type EndedTurn = { outcome: TurnOutcome; text: string; durationMs: number }

function rowsOfLatestRequest(rows: readonly FlowRow[]): readonly FlowRow[] {
  return rows.slice(rows.findLastIndex(startsNewRequest) + 1)
}

/**
 * 마지막 설명 줄이 곧 최종 답이면 같은 말이 두 번 보이지 않게 그 줄을 끝 줄로 바꾼다.
 * 이 요청에서 띄운 에이전트가 아직 돌면 일이 끝난 게 아니니 완료로 표시하지 않는다.
 * 앞선 요청의 에이전트까지 세면 상관없는 답이 전부 미완료처럼 보인다.
 */
export function closeTurn(
  rows: readonly FlowRow[],
  turn: EndedTurn,
  stamp: RowStamp,
): FlowRow[] {
  const last = rows.at(-1)
  const isAnswerRepeated = last?.kind === 'narration' && last.text === turn.text
  const outcome =
    turn.outcome === 'answered' && hasRunningAgent(rowsOfLatestRequest(rows))
      ? 'waiting'
      : turn.outcome

  return [
    ...(isAnswerRepeated ? rows.slice(0, -1) : rows),
    { ...stamp, kind: 'turn-end', ...turn, outcome },
  ]
}

export async function addTurnEnd(
  $: EngineInterface,
  turn: EndedTurn,
): Promise<string> {
  const stamp = await stampNow($)
  await update($, flowRows, rows => keepRecent(closeTurn(rows, turn, stamp)))

  return stamp.id
}

export function openQuestions(rows: readonly FlowRow[]): QuestionRow[] {
  return rows.filter(
    (row): row is QuestionRow => row.kind === 'question' && row.isOpen,
  )
}

/**
 * 같은 질문을 턴마다 다시 물어도 한 번만 남긴다.
 * 질문은 요약이 끝나야 알 수 있어서 그사이 사람이 다음 요청을 보냈을 수 있다.
 * 그때는 이미 답한 것이니 닫힌 채로 남기고, 어느 경우든 그 턴의 끝 줄 바로 뒤에 넣는다.
 */
export async function addQuestion(
  $: EngineInterface,
  text: string,
  turnEndRowId: string,
): Promise<void> {
  const stamp = await stampNow($)
  await update($, flowRows, rows => {
    const turnEndIndex = rows.findIndex(row => row.id === turnEndRowId)
    const isAlreadyOpen = openQuestions(rows).some(
      question => question.text === text,
    )

    // 끝 줄이 없으면 요약을 기다리는 사이 /clear나 /resume으로 세션이 바뀐 것이다.
    // 지난 세션의 질문을 새 세션 띠에 올리면 안 된다.
    if (turnEndIndex === -1 || isAlreadyOpen) {
      return rows
    }

    const isAnsweredAlready = rows
      .slice(turnEndIndex + 1)
      .some(row => row.kind === 'request')
    const question: QuestionRow = {
      ...stamp,
      kind: 'question',
      text,
      isOpen: !isAnsweredAlready,
    }

    return keepRecent(rows.toSpliced(turnEndIndex + 1, 0, question))
  })
}

export async function closeQuestions($: EngineInterface): Promise<void> {
  await update($, flowRows, rows =>
    rows.map(row =>
      row.kind === 'question' && row.isOpen ? { ...row, isOpen: false } : row,
    ),
  )
}

/** 요약이 늦게 도착해도 그 사이 쌓인 줄을 건드리지 않도록 id로 찾아 글만 바꾼다. */
export async function replaceRowText(
  $: EngineInterface,
  rowId: string,
  text: string,
): Promise<void> {
  await update($, flowRows, rows =>
    rows.map(row =>
      row.id === rowId && (row.kind === 'request' || row.kind === 'turn-end')
        ? { ...row, text }
        : row,
    ),
  )
}

export async function clearRows($: EngineInterface): Promise<void> {
  await update($, flowRows, () => [])
}

/** 프로세스가 바뀌면 실행 중이던 에이전트의 끝을 들을 수 없다. 상태를 모름으로 돌린다. */
function settleStaleAgents(rows: readonly FlowRow[]): FlowRow[] {
  return rows.map(row =>
    row.kind === 'agent' && row.status === 'running'
      ? { ...row, status: 'unknown' }
      : row,
  )
}

/** 세션을 다시 열었을 때 저장된 줄을 되살린다. 이미 줄이 있으면 건드리지 않는다. */
export async function restoreSavedRows(
  $: EngineInterface,
  saved: readonly FlowRow[],
): Promise<void> {
  await update($, flowRows, rows =>
    rows.length > 0 ? rows : settleWaitingTurns(settleStaleAgents(saved)),
  )
}
