import type {
  AgentInfo,
  EngineInterface,
  Register,
  Timer,
} from 'claude-code'

import { restoreRows, saveRows } from './flow-archive'
import {
  addActivity,
  addAgent,
  addNarration,
  addNotice,
  addQuestion,
  addRequest,
  addTurnEnd,
  clearRows,
  closeQuestions,
  finishAgent,
  openQuestions,
  readRows,
  reopenAgent,
  runningAgentIds,
} from './flow-log'
import { paletteNamed } from './flow-palette'
import type { FlowPalette } from './flow-palette'
import { drawFlowPane } from './flow-pane'
import {
  MIN_CHARS_WORTH_SUMMARIZING,
  digestAnswerLater,
  summarizeRequestLater,
} from './line-summarizer'
import { firstSentence, flattenToOneLine, lastQuestion } from './one-line'
import {
  forgetPaneFolder,
  isPaneRemembered,
  rememberPaneFolder,
} from './pane-memory'
import { drawQuestionBand } from './question-band'
import { describeToolCall } from './tool-activity'

const FLOW_COMMAND = 'flow'
const PANE_ID = 'session-flow'
const PANE_TITLE = '세션 흐름'
/** 인라인으로 뜰 때의 높이와 옆에 붙을 때의 폭. 요청일 뿐 사람이 조절한 크기가 우선한다. */
const PANE_ROWS = 14
const PANE_COLUMNS = 56
/** 턴이 끝난 뒤 에이전트 상태가 자리 잡기를 기다리는 시간. */
const AGENT_STATUS_SETTLE_MS = 300
/** 턴이 끝나도 일이 남은 상태. 백그라운드 작업을 기다리면 깨어나서 턴이 또 온다. */
const UNFINISHED_AGENT_STATUSES = new Set(['pending', 'running', 'waiting'])
/** 도는 에이전트가 있는 동안 엔진 목록과 맞추는 간격. */
const AGENT_WATCH_MS = 5_000
const FOLLOW_RETRY_MS = 100
const MAX_FOLLOW_ATTEMPTS = 20
/** 모델 이름에서 계열만 뽑는다. claude-opus-5-5 → opus. */
const MODEL_FAMILY = /fable|opus|sonnet|haiku/

function modelFamily(model: string): string {
  return model.match(MODEL_FAMILY)?.[0] ?? model
}

async function openFlowPane($: EngineInterface, palette: FlowPalette) {
  await $.ui.open({
    id: PANE_ID,
    title: PANE_TITLE,
    rows: PANE_ROWS,
    columns: PANE_COLUMNS,
    ...(palette.paneBackground === undefined
      ? {}
      : { backgroundColor: palette.paneBackground }),
  })
}

/** 끝으로 옮기면 엔진이 늘어나는 줄을 따라간다. 사람이 스크롤하면 그때 멈춘다. */
async function followNewestRows($: EngineInterface) {
  return $.ui.scroll({ in: PANE_ID, to: 'end' })
}

/**
 * 창은 열린 직후 아직 그려지기 전이라 스크롤이 거절된다.
 * 그려질 때까지 짧게 다시 시도하고, 끝내 안 되면 사람이 스크롤할 수 있으니 그만둔다.
 */
function followNewestRowsOnceDrawn(
  $: EngineInterface,
  attemptsLeft = MAX_FOLLOW_ATTEMPTS,
) {
  $.clock.after(FOLLOW_RETRY_MS, async () => {
    const moved = await followNewestRows($)

    if (moved.deny !== undefined && attemptsLeft > 1) {
      followNewestRowsOnceDrawn($, attemptsLeft - 1)
    }
  })
}

// 엔진 목록에서 본 에이전트. 워크플로 에이전트는 원래 목록에 없어서,
// 본 적 있는 id가 사라졌을 때만 끝난 것으로 친다.
const agentsSeenInList = new Set<string>()
let agentWatch: Timer | undefined

function endStatusOf(status: AgentInfo['status']): 'done' | 'failed' {
  return status === 'completed' || status === 'idle' ? 'done' : 'failed'
}

/**
 * 백그라운드 작업을 기다리다 멈춘 에이전트는 끝을 알리는 이벤트가 오지 않고,
 * 엔진 목록에서도 잠시 뒤 빠진다. 그래서 도는 줄을 목록과 계속 맞춘다.
 */
async function finishEndedAgents($: EngineInterface) {
  const running = runningAgentIds(await readRows($))

  if (running.length === 0) {
    return
  }

  const agents = await $.agent.list()

  for (const agentId of running) {
    const agent = agents.find(one => one.id === agentId)

    if (agent === undefined) {
      if (agentsSeenInList.has(agentId)) {
        await finishAgent($, agentId, 'unknown')
      }
    } else {
      agentsSeenInList.add(agentId)

      if (!UNFINISHED_AGENT_STATUSES.has(agent.status)) {
        await finishAgent($, agentId, endStatusOf(agent.status))
      }
    }
  }
}

/** 멈춤은 턴을 시작하지 않으니 다음 턴을 기다리지 않고 직접 살핀다. */
function watchRunningAgents($: EngineInterface) {
  agentWatch ??= $.clock.every(AGENT_WATCH_MS, async () => {
    await finishEndedAgents($)

    if (runningAgentIds(await readRows($)).length === 0) {
      agentWatch?.cancel()
      agentWatch = undefined
    }
  })
}

/**
 * 에이전트의 턴이 끝났다고 일이 끝난 건 아니다. 백그라운드 작업을 기다리다 깨어나면
 * 턴이 또 온다. 그래서 엔진이 아는 상태로 판단한다. 목록에 없으면(워크플로 에이전트)
 * 턴의 결과를 믿는다.
 */
function settleAgentLater(
  $: EngineInterface,
  agentId: string,
  hasAnswered: boolean,
) {
  $.clock.after(AGENT_STATUS_SETTLE_MS, async () => {
    const agents = await $.agent.list()
    const agent = agents.find(one => one.id === agentId)

    if (agent !== undefined && UNFINISHED_AGENT_STATUSES.has(agent.status)) {
      return
    }

    const fallbackStatus = hasAnswered ? 'done' : 'failed'

    await finishAgent(
      $,
      agentId,
      agent === undefined ? fallbackStatus : endStatusOf(agent.status),
    )
  })
}

async function recordRequest(
  $: EngineInterface,
  text: string,
  isSummarizing: boolean,
  isInterjection: boolean,
) {
  // 입력칸 바로 위에 있던 질문이라 다음 요청을 치는 순간 사람이 본 것으로 친다.
  await closeQuestions($)
  const rowId = await addRequest($, flattenToOneLine(text), isInterjection)

  if (isSummarizing && text.length >= MIN_CHARS_WORTH_SUMMARIZING) {
    summarizeRequestLater($, rowId, text)
  }
}

export const register: Register = (on, options) => {
  const palette = paletteNamed(options.palette)
  // claude -p 같은 자동 실행은 보는 사람이 없다. 저장 칸을 차지하거나 요약 호출을 쓰지 않는다.
  let isHeadless = false
  // 세션 시작 시점에는 fullscreen인지 모른다. 첫 그리기에서 판단하려고 맡겨 둔다.
  let isPaneRestorePending = false
  const isSummarizing = () => options.summarize === true && !isHeadless
  // 로컬 명령은 턴을 시작하지 않는다. 턴이 실제로 시작될 때까지 들고 있다가 기록한다.
  let requestAwaitingTurn: string | undefined
  let placementDrawn: string | undefined
  let rowCountDrawn = 0
  let isPersonReading = false
  let endedSessionId: string | undefined

  on('session.start', async ($, e, next) => {
    isHeadless = !e.isInteractive
    await $.command.register({
      name: FLOW_COMMAND,
      description: '세션 흐름 로그 창을 열거나 닫습니다',
      // 로그는 일이 돌고 있을 때 보고 싶다. 턴이 끝나길 기다리면 쓸모가 없다.
      immediate: true,
    })
    await restoreRows($, await $.session.id())
    isPaneRestorePending =
      e.isInteractive && (await isPaneRemembered($, await $.session.root()))

    // 첫 그리기가 여기보다 먼저 끝난다. 다시 그리게 해야 띠 훅이 맡긴 일을 본다.
    if (isPaneRestorePending) {
      $.ui.invalidate('ui.render')
    }

    // 다시 불러온 모드의 타이머는 사라진다. 돌던 에이전트가 있으면 다시 살핀다.
    if (runningAgentIds(await readRows($)).length > 0) {
      watchRunningAgents($)
    }

    return next(e)
  })

  // session.start는 프로세스마다 한 번뿐이다. 세션 안에서 /resume, /branch로 옮기면 여기만 온다.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'resume') {
      await restoreRows($, e.session_id)
    }

    if (e.source === 'fork' && endedSessionId !== undefined) {
      await restoreRows($, endedSessionId)
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    endedSessionId = e.sessionId

    if (!isHeadless) {
      await saveRows($, e.sessionId)
    }

    // 프로세스는 이어지고 세션만 바뀌는 두 경우다. 이전 세션의 줄이 섞이면 안 된다.
    if (e.reason === 'clear' || e.reason === 'resume') {
      await clearRows($)
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const isPersonRequest =
      e.isMeta !== true && e.origin.kind !== 'task-notification'

    if (e.command?.name === FLOW_COMMAND) {
      return next(e)
    }

    if (!isPersonRequest) {
      requestAwaitingTurn = undefined

      return next(e)
    }

    // 돌고 있는 턴에 끼어든 글은 turn.start가 다시 오지 않으니 바로 기록한다.
    if (e.turnId !== undefined && e.command === undefined) {
      await recordRequest($, e.text, isSummarizing(), true)

      return next(e)
    }

    // next가 끝나기 전에 turn.start가 먼저 온다. 그래서 호출 전에 맡겨 둔다.
    requestAwaitingTurn = e.text
    const entered = await next(e)

    if (entered.drop !== undefined) {
      requestAwaitingTurn = undefined
    }

    return entered
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && requestAwaitingTurn !== undefined) {
      const request = requestAwaitingTurn
      requestAwaitingTurn = undefined
      await recordRequest($, request, isSummarizing(), false)
    }

    return next(e)
  })

  // 끈 상태에서는 등록하지 않는다. 등록만 해도 모델 응답의 모든 블록이 훅을 거친다.
  if (options.showNarration === true) {
    on('session.append', { door: 'response' }, async ($, e, next) => {
      const stored = await next(e)

      if (e.agentId === undefined && e.message.type === 'assistant') {
        const text = e.message.content
          .flatMap(block => (block.type === 'text' ? [block.text] : []))
          .join('\n')
        const sentence = firstSentence(text)

        if (sentence.length > 0) {
          await addNarration($, sentence)
        }
      }

      return stored
    })
  }

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const isMainLoop = e.agentId === undefined
    const hasSucceeded = ran.deny === undefined && ran.isError !== true

    if (isMainLoop && hasSucceeded) {
      for (const activity of describeToolCall(e, ran.text)) {
        await addActivity($, activity)
      }
    }

    return ran
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)

    if (started.deny !== undefined) {
      return started
    }

    const isWakeUp =
      e.resume !== undefined && (await reopenAgent($, e.resume.agentId))

    if (!isWakeUp) {
      await addAgent($, {
        description: e.description,
        model: modelFamily(started.model),
        agentId: started.agentId,
        parentAgentId: e.parentAgentId,
      })
    }

    watchRunningAgents($)

    return started
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      settleAgentLater($, e.agentId, e.reason === 'answer')

      return next(e)
    }

    // 끝 줄의 ⋯ 판단이 맞으려면 그 전에 멈춘 에이전트를 정리해 둬야 한다.
    await finishEndedAgents($)

    const rowId = await addTurnEnd($, {
      outcome:
        e.reason === 'answer'
          ? 'answered'
          : e.reason === 'aborted'
            ? 'aborted'
            : 'failed',
      text: firstSentence(e.answer),
      durationMs: e.durationMs,
    })
    const isDigestWorthwhile =
      isSummarizing() &&
      e.reason === 'answer' &&
      e.answer.length >= MIN_CHARS_WORTH_SUMMARIZING
    const question =
      e.reason === 'answer' && !isDigestWorthwhile
        ? lastQuestion(e.answer)
        : undefined

    if (question !== undefined) {
      await addQuestion($, question, rowId)
    }

    if (!isHeadless) {
      await saveRows($, await $.session.id())
    }

    if (isDigestWorthwhile) {
      digestAnswerLater($, rowId, e.answer)
    }

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)

    if (e.agentId === undefined && compacted.skip === undefined) {
      await addNotice($, '대화 압축됨')
    }

    return compacted
  })

  on('command.run', { command: FLOW_COMMAND }, async $ => {
    // 폭이 모자라 대기 중인 창은 목록에 있어도 사람에게는 닫힌 창이다.
    const isOpen = (await $.ui.panes()).some(
      pane => pane.id === PANE_ID && pane.isPlaced,
    )

    if (isOpen) {
      await forgetPaneFolder($, await $.session.root())
      await $.ui.close({ id: PANE_ID })
    } else {
      await openFlowPane($, palette)
      await rememberPaneFolder($, await $.session.root())
      followNewestRowsOnceDrawn($)
    }

    return {}
  })

  // 사람이 직접 닫으면 엔진이 폴더 구분 없이 '연 적 있음' 기억을 지워, 다른 폴더의
  // 자동 열기까지 144칸을 요구하게 된다. 닫을 뜻은 그대로 두고 모드가 대신 닫는다.
  // 세션을 끝낼 때는 이 훅이 불리지 않아 폴더 기억이 남는다.
  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE_ID || e.origin.kind !== 'person') {
      return next(e)
    }

    await forgetPaneFolder($, await $.session.root())
    $.clock.after(0, () => void $.ui.close({ id: PANE_ID }))

    return { value: undefined }
  })

  on('ui.scroll', { requestId: PANE_ID }, async ($, e, next) => {
    const moved = await next(e)

    if (e.origin.kind === 'person') {
      // 사람이 위로 올리면 따라가기를 멈추고, 맨 아래로 돌아오면 다시 켠다.
      isPersonReading = e.offset < e.contentRows - e.bodyRows

      if (!isPersonReading) {
        await followNewestRows($)
      }
    }

    return moved
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const isFullscreen = e.viewport?.isFullscreen

    // 옆에 붙을 때만 자동으로 연다. 일반 화면에서는 창이 프롬프트 위를 차지해 방해가 된다.
    if (isPaneRestorePending && isFullscreen !== undefined) {
      isPaneRestorePending = false

      if (isFullscreen) {
        void openFlowPane($, palette)
      }
    }

    const questions = openQuestions(await readRows($))

    if (e.props.hasSurvey || questions.length === 0) {
      return next(e)
    }

    return drawQuestionBand($.ui.resolve(e), questions, palette, () =>
      closeQuestions($),
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const rows = await readRows($)
    const isPlacementChanged = e.props.placement !== placementDrawn

    // 엔진의 끝 따라가기는 창이 조금만 움직여도 풀린다(폭 변경, /config 등).
    // 그래서 그릴 내용이 바뀔 때마다 다시 건다. 창이 다시 놓이면 읽던 자리도 사라진다.
    if (isPlacementChanged) {
      isPersonReading = false
    }

    if ((isPlacementChanged || rows.length !== rowCountDrawn) && !isPersonReading) {
      followNewestRowsOnceDrawn($)
    }

    placementDrawn = e.props.placement
    rowCountDrawn = rows.length

    return drawFlowPane($.ui.resolve(e), rows, e.props.bodyColumns, palette)
  })
}
