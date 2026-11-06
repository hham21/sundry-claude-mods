import type { ElementTable } from 'claude-code'

import type { QuestionRow } from '../types'
import { clipToCells } from './one-line'

/** 띠가 프롬프트를 밀어 올리지 않게 최근 질문만 보인다. */
const MAX_BAND_QUESTIONS = 3
/** 질문 하나가 차지할 수 있는 줄 수. */
const MAX_QUESTION_LINES = 2
/** `? ` 머리표와 `[ 확인 ]` 버튼, 줄바꿈 여유를 합친 칸 수. */
const RESERVED_CELLS = 20

type Elements = Pick<ElementTable, 'Box' | 'Button' | 'Text'>

export function drawQuestionBand(
  { Box, Button, Text }: Elements,
  questions: readonly QuestionRow[],
  bodyColumns: number,
  dismiss: () => unknown,
) {
  const shown = questions.slice(-MAX_BAND_QUESTIONS)
  const hiddenCount = questions.length - shown.length
  const maxCells = bodyColumns * MAX_QUESTION_LINES - RESERVED_CELLS

  return (
    <Box flexDirection="row">
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {shown.map(question => (
          <Text wrap="wrap" color="warning">
            ? {clipToCells(question.text, maxCells)}
          </Text>
        ))}
        {hiddenCount > 0 && <Text dimColor>외 {hiddenCount}개는 /flow에서 볼 수 있어요</Text>}
      </Box>
      <Box flexShrink={0} marginLeft={1}>
        <Button key="seen" label="확인" onPress={dismiss} />
      </Box>
    </Box>
  )
}
