import type { EngineInterface } from 'claude-code'

/** 로그 창을 열어 둔 프로젝트 폴더 목록. 다음 세션에서 그 폴더만 자동으로 연다. */
const PANE_FOLDERS_KEY = 'pane-folders'
/** 오래 안 쓴 폴더가 저장소에 끝없이 쌓이지 않게 묶는다. */
const MAX_REMEMBERED_FOLDERS = 50

async function rememberedFolders($: EngineInterface): Promise<string[]> {
  const saved = await $.store.get(PANE_FOLDERS_KEY)

  return Array.isArray(saved) ? (saved as string[]) : []
}

export async function isPaneRemembered(
  $: EngineInterface,
  folder: string,
): Promise<boolean> {
  return (await rememberedFolders($)).includes(folder)
}

export async function rememberPaneFolder(
  $: EngineInterface,
  folder: string,
): Promise<void> {
  const others = (await rememberedFolders($)).filter(known => known !== folder)

  await $.store.set(
    PANE_FOLDERS_KEY,
    [...others, folder].slice(-MAX_REMEMBERED_FOLDERS),
  )
}

export async function forgetPaneFolder(
  $: EngineInterface,
  folder: string,
): Promise<void> {
  const others = (await rememberedFolders($)).filter(known => known !== folder)

  await $.store.set(PANE_FOLDERS_KEY, others)
}
