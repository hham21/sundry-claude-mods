import type { ElementTable } from 'claude-code'

import type { AgentRow, FlowRow, TurnEndRow } from '../types'
import type { FlowPalette } from './flow-palette'

/** 이 폭보다 좁으면 시각을 빼고 내용에 자리를 준다. */
const MIN_COLUMNS_FOR_TIME = 40
/** 합쳐진 줄에서 이름을 다 보여 줄 항목 수. 나머지는 개수로 줄인다. */
const MAX_LISTED_ITEMS = 2

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

function agentStatusColor(status: AgentRow['status'], palette: FlowPalette) {
  switch (status) {
    case 'running':
      return palette.waiting
    case 'done':
      return palette.done
    case 'failed':
      return palette.failed
    case 'unknown':
      return palette.unknown
  }
}

const TURN_END_MARK: Record<TurnEndRow['outcome'], string> = {
  answered: '✓',
  waiting: '⋯',
  aborted: '■',
  failed: '✗',
}

function turnEndColor(outcome: TurnEndRow['outcome'], palette: FlowPalette) {
  switch (outcome) {
    case 'answered':
      return palette.done
    case 'waiting':
      return palette.waiting
    case 'aborted':
    case 'failed':
      return palette.failed
  }
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

function styleOf(row: FlowRow, palette: FlowPalette): RowStyle {
  switch (row.kind) {
    case 'request':
      return { color: palette.request, bold: true }
    case 'turn-end':
      return { color: turnEndColor(row.outcome, palette) }
    case 'question':
      return row.isOpen ? { color: palette.waiting } : { dimColor: true }
    case 'narration':
      return { dimColor: true }
    case 'notice':
      return { dimColor: true, italic: true }
    case 'activity':
    case 'agent':
      return {}
  }
}

function drawBody(row: FlowRow, palette: FlowPalette, { Text }: Elements) {
  switch (row.kind) {
    case 'request':
    case 'narration':
    case 'question':
    case 'notice':
      return row.text
    case 'activity':
      return (
        <Text>
          <Text color={palette.label}>{row.label}</Text> {listItems(row.items)}
        </Text>
      )
    case 'agent':
      return (
        <Text>
          <Text color={palette.label}>{AGENT_LABEL}</Text>{' '}
          <Text color={agentStatusColor(row.status, palette)}>
            {AGENT_STATUS_MARK[row.status]}
          </Text>{' '}
          {agentDuration(row)}
          {row.description} <Text dimColor>· {row.model}</Text>
        </Text>
      )
    case 'turn-end': {
      const duration = formatDuration(row.durationMs)

      return row.text.length > 0 ? `${duration} · ${row.text}` : duration
    }
  }
}

function drawRow(
  row: FlowRow,
  elements: Elements,
  palette: FlowPalette,
  isTimeShown: boolean,
  isFirstRow: boolean,
) {
  const { Box, Text } = elements
  const style = styleOf(row, palette)

  // 머리표를 따로 두어 둘째 줄이 글 시작 위치에 맞게 한다.
  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      marginTop={row.kind === 'request' && !isFirstRow ? 1 : 0}
    >
      <Box key={`row:${row.id}`} flexDirection="row" flexShrink={1}>
        <Box flexShrink={0}>
          <Text {...style}>{prefixOf(row)}</Text>
        </Box>
        <Box flexShrink={1}>
          <Text wrap="wrap" {...style}>
            {drawBody(row, palette, elements)}
          </Text>
        </Box>
      </Box>
      {row.kind === 'request' && isTimeShown && (
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
  palette: FlowPalette,
) {
  const { Box, Text } = elements
  const isTimeShown = bodyColumns >= MIN_COLUMNS_FOR_TIME

  if (rows.length === 0) {
    return <Text dimColor>아직 기록이 없어요. 일을 시키면 여기에 쌓입니다.</Text>
  }

  return (
    <Box flexDirection="column">
      {rows.map((row, index) =>
        drawRow(row, elements, palette, isTimeShown, index === 0),
      )}
    </Box>
  )
}
