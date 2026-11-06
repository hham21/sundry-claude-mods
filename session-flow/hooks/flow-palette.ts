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

export function paletteNamed(name: unknown): FlowPalette {
  return name === 'claude' ? CLAUDE_PALETTE : CATPPUCCIN_PALETTE
}
