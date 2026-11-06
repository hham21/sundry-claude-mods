import type { Color } from 'claude-code'

export type FlowPalette = {
  request: Color
  done: Color
  waiting: Color
  failed: Color
  label: Color
  unknown: Color
  /** 창 배경. 없으면 터미널이 정한 그대로 둔다. */
  paneBackground?: Color
}

/** Claude Code 테마를 따라가는 색. 라이트 테마에서도 읽힌다. */
const CLAUDE_PALETTE: FlowPalette = {
  request: 'claude',
  done: 'success',
  waiting: 'warning',
  failed: 'error',
  label: 'suggestion',
  unknown: 'subtle',
}

/**
 * herdr의 Catppuccin Mocha 테마에 맞춘 색. 시킨 일은 herdr 강조색(Mauve), 창 배경은
 * herdr 사이드바(Mantle)와 같다. 고정 값이라 라이트 테마에서는 맞지 않는다.
 */
const CATPPUCCIN_PALETTE: FlowPalette = {
  request: '#cba6f7',
  done: '#a6e3a1',
  waiting: '#f9e2af',
  failed: '#f38ba8',
  label: '#89b4fa',
  unknown: '#6c7086',
  paneBackground: '#181825',
}

/** Dracula 공식 팔레트. 창 배경은 사이드바에 쓰는 한 단계 어두운 색이다. */
const DRACULA_PALETTE: FlowPalette = {
  request: '#bd93f9',
  done: '#50fa7b',
  waiting: '#f1fa8c',
  failed: '#ff5555',
  label: '#8be9fd',
  unknown: '#6272a4',
  paneBackground: '#21222c',
}

const PALETTES: Record<string, FlowPalette> = {
  catppuccin: CATPPUCCIN_PALETTE,
  dracula: DRACULA_PALETTE,
  claude: CLAUDE_PALETTE,
}

export function paletteNamed(name: unknown): FlowPalette {
  return PALETTES[String(name)] ?? CATPPUCCIN_PALETTE
}
