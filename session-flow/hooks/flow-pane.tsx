import type { ElementTable } from 'claude-code'

import type { AgentRow, FlowRow, TurnEndRow } from '../types'
import { cellWidth, clipToCells } from './one-line'

/** 이 폭보다 좁으면 시각을 빼고 내용에 자리를 준다. */
const MIN_COLUMNS_FOR_TIME = 40
/** 시각 다섯 칸과 그 앞의 여백. */
const TIME_CELLS = 6
/** 합쳐진 줄에서 이름을 다 보여 줄 항목 수. 나머지는 개수로 줄인다. */
const MAX_LISTED_ITEMS = 2
/** 한 항목이 차지할 수 있는 줄 수. 폭이 좁아도 글이 잘려 나가지 않게 접는다. */
const MAX_ROW_LINES = 2
/** 줄바꿈이 낱말 단위라 칸을 꽉 채우지 못한다. 셋째 줄로 넘어가지 않게 여유를 둔다. */
const WRAP_SLACK_CELLS = 8

type Elements = Pick<ElementTable, 'Box' | 'Text'>
type RowStyle = {
  color?: string
  bold?: boolean
  dimColor?: boolean
  italic?: boolean
}

const twoDigits = (value: number) => String(value).padStart(2, '0')

function clockTime(at: number): string {
  const time = new Date(at)

  return `${twoDigits(time.getHours())}:${twoDigits(time.getMinutes())}`
}

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return minutes > 0 ? `${hours}시간 ${minutes}분` : `${hours}시간`
  }

  if (minutes > 0) {
    return seconds > 0 && minutes < 10
      ? `${minutes}분 ${seconds}초`
      : `${minutes}분`
  }

  return `${seconds}초`
}

function listItems(items: readonly string[]): string {
  const listed = items.slice(0, MAX_LISTED_ITEMS).join(', ')
  const hidden = items.length - MAX_LISTED_ITEMS

  return hidden > 0 ? `${listed} 외 ${hidden}개` : listed
}

const AGENT_STATUS_MARK: Record<AgentRow['status'], string> = {
  running: '⋯',
  done: '✓',
  failed: '✗',
  unknown: '?',
}

const AGENT_STATUS_COLOR: Record<AgentRow['status'], string> = {
  running: 'warning',
  done: 'success',
  failed: 'error',
  unknown: 'subtle',
}

const TURN_END_MARK: Record<TurnEndRow['outcome'], string> = {
  answered: '✓',
  waiting: '⋯',
  aborted: '■',
  failed: '✗',
}

const TURN_END_COLOR: Record<TurnEndRow['outcome'], string> = {
  answered: 'success',
  waiting: 'warning',
  aborted: 'error',
  failed: 'error',
}

const ROW_BULLET = '· '
const ROW_INDENT = '  '
const LIST_PREFIX = `${ROW_INDENT}${ROW_BULLET}`
const AGENT_LABEL = '에이전트'

function agentDuration(row: AgentRow): string {
  return row.durationMs === undefined ? '' : `${formatDuration(row.durationMs)} `
}

function agentPrefix(row: AgentRow): string {
  return `${ROW_INDENT.repeat(row.depth + 1)}${ROW_BULLET}`
}

function prefixOf(row: FlowRow): string {
  switch (row.kind) {
    case 'request':
      return '❯ '
    case 'agent':
      return agentPrefix(row)
    case 'turn-end':
      return `${TURN_END_MARK[row.outcome]} `
    case 'question':
      return `${ROW_INDENT}? `
    case 'narration':
    case 'activity':
    case 'notice':
      return LIST_PREFIX
  }
}

function styleOf(row: FlowRow): RowStyle {
  switch (row.kind) {
    case 'request':
      return { color: 'claude', bold: true }
    case 'turn-end':
      return { color: TURN_END_COLOR[row.outcome] }
    case 'question':
      return row.isOpen ? { color: 'warning' } : { dimColor: true }
    case 'narration':
      return { dimColor: true }
    case 'notice':
      return { dimColor: true, italic: true }
    case 'activity':
    case 'agent':
      return {}
  }
}

/** 고정된 글을 뺀 나머지 자리에 맞춰 줄의 내용을 자른다. */
function clipBody(text: string, rowCells: number, fixedText = ''): string {
  return clipToCells(text, rowCells - cellWidth(fixedText))
}

function drawBody(row: FlowRow, rowCells: number, { Text }: Elements) {
  switch (row.kind) {
    case 'request':
    case 'narration':
    case 'question':
    case 'notice':
      return clipBody(row.text, rowCells)
    case 'activity':
      return (
        <Text>
          <Text color="suggestion">{row.label}</Text>{' '}
          {clipBody(listItems(row.items), rowCells, `${row.label} `)}
        </Text>
      )
    case 'agent': {
      const mark = AGENT_STATUS_MARK[row.status]
      const duration = agentDuration(row)
      const model = ` · ${row.model}`

      // 상태와 시간이 설명 앞에 있어야 글이 잘려도 보인다.
      return (
        <Text>
          <Text color="suggestion">{AGENT_LABEL}</Text>{' '}
          <Text color={AGENT_STATUS_COLOR[row.status]}>{mark}</Text> {duration}
          {clipBody(
            row.description,
            rowCells,
            `${AGENT_LABEL} ${mark} ${duration}${model}`,
          )}
          <Text dimColor>{model}</Text>
        </Text>
      )
    }
    case 'turn-end': {
      const duration = formatDuration(row.durationMs)

      return row.text.length > 0
        ? `${duration} · ${clipBody(row.text, rowCells, `${duration} · `)}`
        : duration
    }
  }
}

function drawRow(
  row: FlowRow,
  elements: Elements,
  bodyColumns: number,
  isTimeShown: boolean,
  isFirstRow: boolean,
) {
  const { Box, Text } = elements
  const prefix = prefixOf(row)
  const style = styleOf(row)
  const isTimeOnRow = row.kind === 'request' && isTimeShown
  const textColumns =
    bodyColumns - cellWidth(prefix) - (isTimeOnRow ? TIME_CELLS : 0)
  const rowCells = textColumns * MAX_ROW_LINES - WRAP_SLACK_CELLS

  // 머리표를 따로 두어 둘째 줄이 글 시작 위치에 맞게 한다.
  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      marginTop={row.kind === 'request' && !isFirstRow ? 1 : 0}
    >
      <Box key={`row:${row.id}`} flexDirection="row" flexShrink={1}>
        <Box flexShrink={0}>
          <Text {...style}>{prefix}</Text>
        </Box>
        <Box flexShrink={1}>
          <Text wrap="wrap" {...style}>
            {drawBody(row, rowCells, elements)}
          </Text>
        </Box>
      </Box>
      {isTimeOnRow && (
        <Box flexShrink={0} marginLeft={1}>
          <Text dimColor>{clockTime(row.at)}</Text>
        </Box>
      )}
    </Box>
  )
}

export function drawFlowPane(
  elements: Elements,
  rows: readonly FlowRow[],
  bodyColumns: number,
) {
  const { Box, Text } = elements
  const isTimeShown = bodyColumns >= MIN_COLUMNS_FOR_TIME

  if (rows.length === 0) {
    return <Text dimColor>아직 기록이 없어요. 일을 시키면 여기에 쌓입니다.</Text>
  }

  return (
    <Box flexDirection="column">
      {rows.map((row, index) =>
        drawRow(row, elements, bodyColumns, isTimeShown, index === 0),
      )}
    </Box>
  )
}
