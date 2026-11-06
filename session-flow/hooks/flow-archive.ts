import type { EngineInterface } from 'claude-code'

import type { FlowRow } from '../types'
import { readRows, restoreSavedRows } from './flow-log'

/**
 * 저장소 전체 한도(4MiB) 안에 들도록 세션 수가 아니라 저장 줄 수로 묶는다.
 * 세션 수로 묶으면 짧은 세션 몇 개에 며칠 전 세션의 로그가 밀려난다.
 * 한 줄이 길어도 500바이트쯤이라 이 값이면 한도를 넘지 않는다.
 */
const MAX_SAVED_ROWS = 6_000
const SESSION_LIST_KEY = 'saved-sessions'

type SavedSession = { id: string; rowCount: number }

function rowsKey(sessionId: string): string {
  return `rows:${sessionId}`
}

function totalRows(sessions: readonly SavedSession[]): number {
  return sessions.reduce((total, session) => total + session.rowCount, 0)
}

/** 오래된 세션부터 덜어 내 상한 안으로 맞추고, 덜어 낸 세션을 돌려준다. */
function splitExpired(sessions: readonly SavedSession[]) {
  const kept = [...sessions]
  const expired: SavedSession[] = []

  while (kept.length > 1 && totalRows(kept) > MAX_SAVED_ROWS) {
    expired.push(...kept.splice(0, 1))
  }

  return { kept, expired }
}

async function rememberSession(
  $: EngineInterface,
  sessionId: string,
  rowCount: number,
): Promise<void> {
  const saved = await $.store.get(SESSION_LIST_KEY)
  const known = Array.isArray(saved) ? (saved as SavedSession[]) : []
  const { kept, expired } = splitExpired([
    ...known.filter(session => session.id !== sessionId),
    { id: sessionId, rowCount },
  ])

  await Promise.all(expired.map(session => $.store.delete(rowsKey(session.id))))
  await $.store.set(SESSION_LIST_KEY, kept)
}

/** 턴이 끝날 때와 세션이 끝날 때만 저장한다. 도구 호출마다 저장소를 쓸 이유가 없다. */
export async function saveRows(
  $: EngineInterface,
  sessionId: string,
): Promise<void> {
  const rows = await readRows($)

  if (rows.length === 0) {
    return
  }

  await $.store.set(rowsKey(sessionId), rows)
  await rememberSession($, sessionId, rows.length)
}

export async function restoreRows(
  $: EngineInterface,
  sessionId: string,
): Promise<void> {
  const saved = await $.store.get(rowsKey(sessionId))

  if (!Array.isArray(saved) || saved.length === 0) {
    return
  }

  await restoreSavedRows($, saved as FlowRow[])
}
