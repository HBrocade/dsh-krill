/**
 * 盯住 SPA 当前打开的是哪个会话。
 *
 * dsh 的前端不把会话 id 放进 URL（没有 pushState / 路由），选中状态只活在
 * 它自己的内存里 —— 从外面读不到。而「最后修改的会话文件」也不等于「正在看的
 * 会话」：切到一个旧对话但不发消息，文件根本不会被写。
 *
 * 但 SPA 是挂在**我们自己的** WebContentsView 上的，它发给后端的每个 RPC 都经过
 * 我们能观察的那层。切换会话时必然带上 `sessionId`，记下最近一个就够了。
 *
 * 只读不改：`onBeforeRequest` 里一律原样放行，这里不做任何拦截。
 */
import type { Session } from 'electron'
import { log } from '../backend/log-ring.ts'

let active: string | null = null

/** SPA 最近一次操作涉及的会话 id（形如 `session-<uuid>`）；还没观察到返回 null。 */
export function activeSessionId(): string | null { return active }

/** 从任意 JSON 结构里挖第一个 sessionId —— RPC 载荷的嵌套层次各不相同。 */
function findSessionId(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = findSessionId(v, depth + 1)
      if (found !== null) return found
    }
    return null
  }
  const obj = value as Record<string, unknown>
  const direct = obj['sessionId']
  if (typeof direct === 'string' && direct !== '') return direct
  for (const v of Object.values(obj)) {
    const found = findSessionId(v, depth + 1)
    if (found !== null) return found
  }
  return null
}

/**
 * 在给定的 session 上装观察器。
 *
 * @param ses - SPA 所在 WebContentsView 的 session
 * @param originOf - 返回当前后端地址；SPA 换端口后要跟着变，所以传函数而不是字符串
 */
export function watch(ses: Session, originOf: () => string | null): void {
  ses.webRequest.onBeforeRequest({ urls: ['http://127.0.0.1/*', 'http://127.0.0.1:*/*'] }, (details, callback) => {
    // 一律放行 —— 这里只旁听，不参与请求
    callback({})
    try {
      const origin = originOf()
      if (origin === null || !details.url.startsWith(origin)) return
      if (details.method !== 'POST') return
      const parts = details.uploadData
      if (parts === undefined || parts.length === 0) return
      for (const part of parts) {
        if (part.bytes === undefined) continue
        const found = findSessionId(JSON.parse(part.bytes.toString('utf8')) as unknown)
        if (found === null || found === active) continue
        active = found
        log(`当前会话切换到 ${found}`)
        return
      }
    } catch { /* 不是 JSON、或结构不认识：旁听失败不该影响任何事 */ }
  })
}
