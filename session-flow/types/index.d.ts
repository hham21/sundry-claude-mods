export type RowStamp = {
  /** 로그 안에서 줄 하나를 가리키는 값. */
  id: string
  /** 기록 시각. 에포크 밀리초. */
  at: number
}

/** 사람이 시킨 일. 흐름의 한 묶음이 여기서 시작한다. */
export type RequestRow = RowStamp & {
  kind: 'request'
  text: string
  /** 돌고 있는 턴에 끼어든 글. 앞선 요청의 일이 이어지고 있다. */
  isInterjection: boolean
}

/** 모델이 도구를 쓰기 전후에 남긴 설명의 첫 문장. */
export type NarrationRow = RowStamp & { kind: 'narration'; text: string }

/** 스킬·검색·수정처럼 한 일. 같은 종류가 이어지면 items에 쌓는다. */
export type ActivityRow = RowStamp & {
  kind: 'activity'
  label: string
  items: string[]
}

export type AgentStatus = 'running' | 'done' | 'failed' | 'unknown'

export type AgentRow = RowStamp & {
  kind: 'agent'
  description: string
  /** 모델 계열. opus, sonnet 같은 짧은 이름. */
  model: string
  /** 끝을 알릴 이벤트와 맞춰 볼 값. 원격 에이전트에는 없다. */
  agentId?: string
  /** 메인 루프가 띄웠으면 0, 에이전트가 띄웠으면 1 이상. */
  depth: number
  status: AgentStatus
  /** 지금 실행의 시작 시각. 끝난 에이전트가 다시 깨어나면 새로 잰다. */
  runStartedAt: number
  /** 끝난 실행들의 시간 합. 기다린 시간도 포함한 벽시계 기준이다. */
  durationMs?: number
}

/** waiting은 답은 했지만 백그라운드 에이전트가 아직 도는 상태다. */
export type TurnOutcome = 'answered' | 'waiting' | 'aborted' | 'failed'

/** 요청 하나가 끝난 자리. */
export type TurnEndRow = RowStamp & {
  kind: 'turn-end'
  outcome: TurnOutcome
  text: string
  durationMs: number
}

/** 모델이 사람의 답을 기다리는 내용. 열려 있는 동안 프롬프트 위 띠에 고정된다. */
export type QuestionRow = RowStamp & {
  kind: 'question'
  text: string
  isOpen: boolean
}

/** 대화 압축처럼 흐름을 이해하는 데 필요한 표시. */
export type NoticeRow = RowStamp & { kind: 'notice'; text: string }

export type FlowRow =
  | RequestRow
  | NarrationRow
  | ActivityRow
  | AgentRow
  | TurnEndRow
  | QuestionRow
  | NoticeRow

declare module 'claude-code' {
  interface PluginState {
    'session-flow': { rows: Shaped<FlowRow[]> }
  }
}
