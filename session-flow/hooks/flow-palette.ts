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

// 아래 값은 각 테마의 공식 저장소 팔레트와 대조했다. 창 배경은 가능하면 사이드바에 쓰는
// 한 단계 어두운 색을 쓴다.
const TOKYO_NIGHT_PALETTE: FlowPalette = {
  request: '#bb9af7',
  done: '#9ece6a',
  waiting: '#e0af68',
  failed: '#f7768e',
  label: '#7aa2f7',
  unknown: '#565f89',
  paneBackground: '#16161e',
}

/** Rosé Pine에는 초록이 없어서 완료는 Foam을 쓴다. */
const ROSE_PINE_PALETTE: FlowPalette = {
  request: '#c4a7e7',
  done: '#9ccfd8',
  waiting: '#f6c177',
  failed: '#eb6f92',
  label: '#ebbcba',
  unknown: '#6e6a86',
  paneBackground: '#191724',
}

const NORD_PALETTE: FlowPalette = {
  request: '#88c0d0',
  done: '#a3be8c',
  waiting: '#ebcb8b',
  failed: '#bf616a',
  label: '#81a1c1',
  unknown: '#4c566a',
  paneBackground: '#2e3440',
}

const GRUVBOX_PALETTE: FlowPalette = {
  request: '#fe8019',
  done: '#b8bb26',
  waiting: '#fabd2f',
  failed: '#fb4934',
  label: '#8ec07c',
  unknown: '#928374',
  paneBackground: '#1d2021',
}

const KANAGAWA_PALETTE: FlowPalette = {
  request: '#957fb8',
  done: '#98bb6c',
  waiting: '#e6c384',
  failed: '#e46876',
  label: '#7e9cd8',
  unknown: '#727169',
  paneBackground: '#16161d',
}

const PALETTES: Record<string, FlowPalette> = {
  catppuccin: CATPPUCCIN_PALETTE,
  dracula: DRACULA_PALETTE,
  'tokyo-night': TOKYO_NIGHT_PALETTE,
  'rose-pine': ROSE_PINE_PALETTE,
  nord: NORD_PALETTE,
  gruvbox: GRUVBOX_PALETTE,
  kanagawa: KANAGAWA_PALETTE,
  claude: CLAUDE_PALETTE,
}

export function paletteNamed(name: unknown): FlowPalette {
  return PALETTES[String(name)] ?? CATPPUCCIN_PALETTE
}
