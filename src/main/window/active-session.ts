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
const listeners = new Set<(id: string) => void>()

/** SPA 最近一次操作涉及的会话 id（形如 `session-<uuid>`）；还没观察到返回 null。 */
export function activeSessionId(): string | null { return active }

/** 订阅「当前会话变了」。切换会话时界面要立刻跟上，不能等下一次轮询。 */
export function onChange(fn: (id: string) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/**
 * 取 sessionId。
 *
 * 只看顶层和 `payload` 这一层 —— 实测 RPC 就放在这两处。先前写的是深度 6 的
 * 全量递归，发消息那种带完整历史的载荷会被整棵走一遍，白白占住主进程。
 */
function findSessionId(root: unknown): string | null {
  if (root === null || typeof root !== 'object') return null
  const obj = root as Record<string, unknown>
  const top = obj['sessionId']
  if (typeof top === 'string' && top !== '') return top
  const payload = obj['payload']
  if (payload === null || typeof payload !== 'object') return null
  const inner = (payload as Record<string, unknown>)['sessionId']
  return typeof inner === 'string' && inner !== '' ? inner : null
}

/** 超过这个大小的载荷不解析：会话 id 从来不在大 body 里，而解析大 JSON 会卡住主进程。 */
const MAX_BODY_SCAN = 64 * 1024

/**
 * 只认这几个方法带来的会话 id。
 *
 * 不能见 sessionId 就认 —— 实测一次启动里 `session.models` 就发了 13 次，
 * 它是给会话列表做预取的，带的是**别的**会话的 id，会把指针挪到用户没在看的
 * 对话上（表现就是新建会话时右栏显示上一个对话的数字）。
 *
 * 这三个才真正意味着「用户此刻在这个会话上」：
 *   session.history     打开某个对话，加载它的历史
 *   session.selectModel 在当前对话上换模型 / 换思考级别
 *   session.prompt      在当前对话上发消息
 */
const TRUSTED_METHODS = new Set(['session.history', 'session.selectModel', 'session.prompt'])

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
        if (part.bytes === undefined || part.bytes.length > MAX_BODY_SCAN) continue
        const body = JSON.parse(part.bytes.toString('utf8')) as unknown
        const method = (body as { method?: unknown }).method
        const trusted = typeof method === 'string' && TRUSTED_METHODS.has(method)
        const found = trusted ? findSessionId(body) : null
        // KRILL_DEBUG_RPC=1 时把每个 RPC 的路径与取到的 id 都打出来 ——
        // 排查「界面上做了某个操作，但当前会话没跟着变」时唯一有用的东西
        if (process.env['KRILL_DEBUG_RPC'] === '1') {
          const path = details.url.slice(details.url.indexOf('/', 8))
          log(`[rpc] ${path} 可信=${String(trusted)} → sessionId=${found ?? '(无)'}`)
        }
        if (found === null || found === active) continue
        active = found
        log(`当前会话切换到 ${found}（由 ${String(method)} 触发）`)
        for (const fn of listeners) {
          try { fn(found) } catch { /* 单个订阅者出错不影响其他 */ }
        }
        return
      }
    } catch { /* 不是 JSON、或结构不认识：旁听失败不该影响任何事 */ }
  })
}
