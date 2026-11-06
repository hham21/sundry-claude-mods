import type { ToolCallInput } from 'claude-code'

/** 로그에 남길 일 하나. 같은 label이 이어지면 한 줄로 합친다. */
export type ToolActivity = { label: string; item: string }

export const RESEARCH_LABEL = '조사'
export const EDIT_LABEL = '수정'

/** 앞에 붙는 환경 변수 지정. GIT_AUTHOR_NAME=a git commit 같은 형태다. */
const ENV_PREFIX = /^(?:\w+=\S*\s+)+/
const GIT_COMMIT_STEP = /^git(?:\s+(?:-[Cc]\s+\S+|--\S+))*\s+commit\b/
const GIT_PUSH_STEP = /^git(?:\s+(?:-[Cc]\s+\S+|--\S+))*\s+push\b/
const PULL_REQUEST_CREATE_STEP = /^gh\s+pr\s+create\b/
/**
 * `git commit`의 출력 줄: [브랜치 해시] 제목. -q로 돌리면 이 줄이 없다.
 * 해시까지 봐야 훅이 찍는 [INFO] 같은 줄을 제목으로 잡지 않는다.
 */
const COMMIT_SUMMARY_LINE = /^\[[^\]]+ [0-9a-f]{7,}\] (.+)$/m
/** -m "제목", -qm '제목', -m "$(cat <<'EOF' 제목 ...)" 모두에서 제목을 꺼낸다. */
const COMMIT_MESSAGE_FLAG =
  /\s-[a-zA-Z]*m\s+(?:"\$\(cat\s+<<-?\s*'?\w+'?\s*\n\s*|["'])?([^"'\n]+)/
const URL_LINE = /https?:\/\/\S+/
const WORKFLOW_META_NAME = /name:\s*['"]([^'"]+)['"]/
const MCP_TOOL_NAME = /^mcp__(.+?)__(.+)$/

/** heredoc 본문은 명령이 아니라 프로그램에 넘기는 글이다. */
const HEREDOC_BODY = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(?=\n|$)/g
/** 따옴표 안의 글은 명령의 구조가 아니다. grep -E 'a|b'의 |는 파이프가 아니다. */
const QUOTED_TEXT = /'[^']*'|"(?:[^"\\]|\\.)*"/g
/** 실제로 올리지 않는 푸시. */
const GIT_PUSH_REHEARSAL = /\s(?:--dry-run|--help|-n)\b/
/** 실행 단계 구분. 파이프도 나눠서 뒤쪽 명령까지 읽기 전용인지 본다. */
const COMMAND_SEPARATOR = /&&|\|\||[;|\n]/
/** 파일로 쓰는 리다이렉트. 2>/dev/null, 2>&1은 읽기를 해치지 않는다. */
const OUTPUT_REDIRECT = /(?:^|[^0-9&])>/
const VARIABLE_ASSIGNMENT = /^\w+=\S*$/
const READ_ONLY_GIT = /^git\s+(?:-C\s+\S+\s+)?(?:log|show|diff|status|blame|grep)\b/
const READ_ONLY_SED = /^sed\s+-n\b/
/** 이 프로그램만으로 이뤄진 명령은 조사로 친다. 이 빌드에는 Grep 도구가 없어 모델이 Bash로 찾는다. */
const READ_ONLY_PROGRAMS = new Set([
  'awk',
  'basename',
  'cat',
  'cut',
  'diff',
  'dirname',
  'du',
  'egrep',
  'fd',
  'file',
  'find',
  'grep',
  'head',
  'jq',
  'less',
  'ls',
  'pwd',
  'realpath',
  'rg',
  'sort',
  'stat',
  'tail',
  'tr',
  'tree',
  'uniq',
  'wc',
  'which',
])
/** 읽지도 바꾸지도 않는 단계. 함께 있어도 되지만 이것만으로는 조사가 아니다. */
const NEUTRAL_PROGRAMS = new Set(['cd', 'echo', 'printf'])
/** 다른 빌드에는 있는 검색 도구. 이 빌드의 도구 표에 없어서 이름 문자열로 비교한다. */
const SEARCH_TOOLS = new Set(['Grep', 'Glob'])

function searchPattern(call: ToolCallInput): string {
  const { pattern } = call as { pattern?: unknown }

  return typeof pattern === 'string' ? pattern : String(call.tool)
}

function fileName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function withoutQuotedText(command: string): string {
  return command.replace(HEREDOC_BODY, '').replace(QUOTED_TEXT, "''")
}

function commandSteps(command: string): string[] {
  return withoutQuotedText(command)
    .split(COMMAND_SEPARATOR)
    .map(step => step.trim().replace(ENV_PREFIX, ''))
    .filter(step => step.length > 0)
}

function programOf(step: string): string {
  return step.split(/\s+/)[0] ?? step
}

function isReadingStep(step: string): boolean {
  return (
    READ_ONLY_PROGRAMS.has(programOf(step)) ||
    READ_ONLY_GIT.test(step) ||
    READ_ONLY_SED.test(step)
  )
}

function isNeutralStep(step: string): boolean {
  return VARIABLE_ASSIGNMENT.test(step) || NEUTRAL_PROGRAMS.has(programOf(step))
}

function isResearchCommand(command: string): boolean {
  const steps = commandSteps(command)

  return (
    !OUTPUT_REDIRECT.test(withoutQuotedText(command)) &&
    steps.some(isReadingStep) &&
    steps.every(step => isReadingStep(step) || isNeutralStep(step))
  )
}

function commitSubject(command: string, output: string): string {
  return (
    output.match(COMMIT_SUMMARY_LINE)?.[1] ??
    command.match(COMMIT_MESSAGE_FLAG)?.[1]?.trim() ??
    '새 커밋'
  )
}

/** 명령은 남기지 않지만 커밋·푸시·PR은 시킨 일의 결과라서 예외로 둔다. */
function milestonesOf(command: string, output: string): ToolActivity[] {
  const steps = commandSteps(command)
  const milestones: ToolActivity[] = []

  if (steps.some(step => GIT_COMMIT_STEP.test(step))) {
    milestones.push({ label: '커밋', item: commitSubject(command, output) })
  }

  const isRealPush = (step: string) =>
    GIT_PUSH_STEP.test(step) && !GIT_PUSH_REHEARSAL.test(step)

  if (steps.some(isRealPush)) {
    milestones.push({ label: '푸시', item: '원격에 올림' })
  }

  if (steps.some(step => PULL_REQUEST_CREATE_STEP.test(step))) {
    milestones.push({
      label: 'PR',
      item: output.match(URL_LINE)?.[0] ?? '새 PR',
    })
  }

  return milestones
}

function describeBash(
  command: string,
  description: string | undefined,
  output: string,
): ToolActivity[] {
  if (isResearchCommand(command)) {
    // 설명이 없어도 명령 전체를 쌓지 않는다. 프로그램 이름만 남긴다.
    const firstReadingStep = commandSteps(command).find(isReadingStep) ?? command

    return [
      {
        label: RESEARCH_LABEL,
        item: description ?? programOf(firstReadingStep),
      },
    ]
  }

  return milestonesOf(command, output)
}

function mcpActivity(toolName: string): ToolActivity[] {
  const [, server, tool] = toolName.match(MCP_TOOL_NAME) ?? []

  if (server === undefined || tool === undefined) {
    return []
  }

  // 서버 이름은 plugin_playwright_playwright처럼 접두어가 붙어 온다. 끝 낱말만 쓴다.
  return [{ label: server.split('_').at(-1) ?? server, item: tool }]
}

/**
 * 끝난 도구 호출 하나를 로그에 남길 일로 바꾼다. 남길 것을 적어 둔 허용 목록이라
 * 여기 없는 도구(ToolSearch 등)와 읽기 전용이 아닌 일반 명령은 기록되지 않는다.
 * Agent는 agent.spawn 이벤트가 따로 맡는다.
 */
export function describeToolCall(
  call: ToolCallInput,
  resultText: string | undefined,
): ToolActivity[] {
  const output = resultText ?? ''

  switch (call.tool) {
    case 'Read':
      return [{ label: RESEARCH_LABEL, item: fileName(call.file_path) }]
    case 'Skill':
      return [{ label: '스킬', item: call.skill.split(':').at(-1) ?? call.skill }]
    case 'WebSearch':
      return [{ label: '검색', item: call.query }]
    case 'WebFetch':
      return [{ label: '웹 읽기', item: hostOf(call.url) }]
    case 'Edit':
    case 'Write':
      return [{ label: EDIT_LABEL, item: fileName(call.file_path) }]
    case 'NotebookEdit':
      return [{ label: EDIT_LABEL, item: fileName(call.notebook_path) }]
    case 'AskUserQuestion':
      return [{ label: '질문', item: call.questions[0]?.question ?? '질문함' }]
    case 'Workflow':
      return [
        {
          label: '워크플로',
          item:
            call.name ??
            call.script?.match(WORKFLOW_META_NAME)?.[1] ??
            '이름 없음',
        },
      ]
    case 'Artifact':
      return (call.action ?? 'publish') === 'publish'
        ? [{ label: '게시', item: fileName(call.file_path ?? '아티팩트') }]
        : []
    case 'Bash':
      return describeBash(call.command, call.description, output)
    default:
      return SEARCH_TOOLS.has(String(call.tool))
        ? [{ label: RESEARCH_LABEL, item: searchPattern(call) }]
        : mcpActivity(String(call.tool))
  }
}
