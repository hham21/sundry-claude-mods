import type { ElementTable } from 'claude-code'

import type { QuestionRow } from '../types'
import type { FlowPalette } from './flow-palette'

/** 띠가 프롬프트를 밀어 올리지 않게 최근 질문만 보인다. */
const MAX_BAND_QUESTIONS = 3

type Elements = Pick<ElementTable, 'Box' | 'Button' | 'Text'>

export function drawQuestionBand(
  { Box, Button, Text }: Elements,
  questions: readonly QuestionRow[],
  palette: FlowPalette,
  dismiss: () => unknown,
) {
  const shown = questions.slice(-MAX_BAND_QUESTIONS)
  const hiddenCount = questions.length - shown.length

  return (
    <Box flexDirection="row">
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {shown.map(question => (
          <Text wrap="wrap" color={palette.waiting}>
            ? {question.text}
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
