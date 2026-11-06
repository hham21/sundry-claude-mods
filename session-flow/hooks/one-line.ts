/** 저장하는 글의 최대 길이. 화면에서는 창 폭에 맞춰 더 잘릴 수 있다. */
const MAX_ROW_CHARS = 160
/** 네 글자는 넘어야 문장으로 친다. "네." 같은 조각만 남는 일을 막는다. */
const SENTENCE_END = /^(.{4,}?[.!?。])(?:\s|$)/u
const FENCED_CODE = /```[\s\S]*?(?:```|$)/g
/** 제목과 표는 답의 내용이 아니라 틀이다. 다른 글이 없을 때만 쓴다. */
const HEADING_OR_TABLE = /^\s*(?:#{1,6}\s|\|)/
/** 사람이 붙여넣은 글을 감싸는 하니스 태그. 사람이 쓴 글이 아니다. */
const PASTE_MARKER = /<\/?pasted_content[^>]*>/g
/** 문장 경계. README.md의 점처럼 뒤에 공백이 없는 점에서는 끊지 않는다. */
const SENTENCE_BREAK = /(?<=[.!?。])\s+|\n+/
const LINE_MARKER = /^\s*(?:#{1,6}|[-*+>]|\d+[.)])\s+/
const INLINE_MARKUP = /\*\*|`/g

function cutToRowLength(text: string): string {
  // 문자 단위로 잘라야 이모지 같은 서로게이트 쌍이 반으로 갈라지지 않는다.
  const characters = Array.from(text)

  return characters.length <= MAX_ROW_CHARS
    ? text
    : `${characters.slice(0, MAX_ROW_CHARS - 1).join('')}…`
}

function stripMarkdown(line: string): string {
  return line.replace(LINE_MARKER, '').replace(INLINE_MARKUP, '').trim()
}

/** 여러 줄 글을 공백만 정리해 한 줄로 만든다. 사람이 쓴 요청에 쓴다. */
export function flattenToOneLine(text: string): string {
  return cutToRowLength(
    text.replace(PASTE_MARKER, ' ').replace(/\s+/g, ' ').trim(),
  )
}

/** 마크다운을 걷어 낸 첫 문장. 모델이 쓴 글에 쓴다. */
export function firstSentence(text: string): string {
  const lines = text.replace(FENCED_CODE, '').split('\n')
  const proseLines = lines.filter(line => !HEADING_OR_TABLE.test(line))
  const firstLine = [...proseLines, ...lines]
    .map(stripMarkdown)
    .find(line => line.length > 0)

  if (firstLine === undefined) {
    return ''
  }

  return cutToRowLength(firstLine.match(SENTENCE_END)?.[1] ?? firstLine)
}

/** 모델을 부르지 않을 때 쓰는 질문 찾기. 물음표로 끝나는 마지막 문장을 고른다. */
export function lastQuestion(text: string): string | undefined {
  const sentence = text
    .replace(FENCED_CODE, '')
    .split(SENTENCE_BREAK)
    .map(stripMarkdown)
    .findLast(candidate => candidate.endsWith('?'))

  return sentence === undefined ? undefined : flattenToOneLine(sentence)
}
