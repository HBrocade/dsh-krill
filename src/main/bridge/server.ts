/**
 * 对外桥接接口：一个只绑回环的本地 HTTP 服务。
 *
 * 用途：让 Claude Code 这类外部工具把 dsh 当作第二意见来源
 * （另一个模型、另一个角度看同一份改动）。
 *
 * 安全边界（这个接口能在本机执行任务，每一条都不是装饰）：
 *   · **默认关闭** —— 要用户在面板上显式打开
 *   · 只绑 127.0.0.1，不接受外部连接
 *   · 强制 `Authorization: Bearer <token>`，token 首次运行随机生成
 *   · 工作目录白名单；即使不限根目录，也必须是真实存在的目录
 *   · 并发上限，避免被打满把机器拖死
 *   · 请求体大小上限，防止内存被撑爆
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { log } from '../backend/log-ring.ts'
import { loadConfig, saveConfig } from '../config/store.ts'
import { currentVersion } from '../update/cli.ts'
import { listProfiles } from '../update/plugins.ts'
import * as runner from './runner.ts'
import type { BridgeStatus } from '@shared/ipc'

/** 请求体上限：diff 可能不小，但 2MB 已经远超正常 code review 的量 */
const MAX_BODY = 2 * 1024 * 1024

let server: Server | null = null
let token = ''
let totalServed = 0
let lastError: string | null = null
const listeners = new Set<() => void>()

export function onChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
function emit(): void {
  for (const fn of listeners) { try { fn() } catch { /* 忽略 */ } }
}

// ─────────────────────────────────────────────────────────────────────────────
// token
// ─────────────────────────────────────────────────────────────────────────────

function ensureToken(): string {
  if (token !== '') return token
  const stored = loadConfig().bridgeToken
  if (stored !== '') { token = stored; return token }
  token = randomBytes(24).toString('base64url')
  saveConfig({ bridgeToken: token })
  return token
}

export function rotateToken(): string {
  token = randomBytes(24).toString('base64url')
  saveConfig({ bridgeToken: token })
  log('桥接 token 已轮换')
  emit()
  return token
}

/** 定长比较，避免用 === 泄露前缀信息。 */
function tokenOk(header: string | undefined): boolean {
  if (header === undefined) return false
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (m === null) return false
  const got = Buffer.from(m[1] ?? '')
  const want = Buffer.from(ensureToken())
  if (got.length !== want.length) return false
  return timingSafeEqual(got, want)
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────────────

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error(`请求体超过上限 ${String(MAX_BODY / 1024 / 1024)}MB`))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') { resolve({}); return }
      try { resolve(JSON.parse(raw)) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cfg = loadConfig().bridge
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname

  if (!tokenOk(req.headers.authorization)) {
    send(res, 401, { error: '缺少或错误的 Bearer token' })
    return
  }

  if (path === '/v1/health' && req.method === 'GET') {
    const status: Record<string, unknown> = {
      ok: true,
      dshVersion: currentVersion(),
      profiles: listProfiles(),
      inflight: runner.inflightCount(),
      maxConcurrent: cfg.maxConcurrent,
      totalServed,
    }
    send(res, 200, status)
    return
  }

  if ((path === '/v1/ask' || path === '/v1/review') && req.method === 'POST') {
    if (runner.inflightCount() >= cfg.maxConcurrent) {
      send(res, 429, { error: `并发已满（上限 ${String(cfg.maxConcurrent)}），稍后再试` })
      return
    }
    let body: Record<string, unknown>
    try {
      body = (await readBody(req)) as Record<string, unknown>
    } catch (e) {
      send(res, 400, { error: e instanceof Error ? e.message : String(e) })
      return
    }

    const prompt = path === '/v1/ask'
      ? String(body['prompt'] ?? '')
      : runner.buildReviewPrompt({
          diff: typeof body['diff'] === 'string' ? body['diff'] : undefined,
          ref: typeof body['ref'] === 'string' ? body['ref'] : undefined,
          focus: typeof body['focus'] === 'string' ? body['focus'] : undefined,
        })

    try {
      const result = await runner.run({
        prompt,
        cwd: typeof body['cwd'] === 'string' ? body['cwd'] : undefined,
        profile: typeof body['profile'] === 'string' ? body['profile'] : cfg.profile,
        timeoutMs: typeof body['timeoutMs'] === 'number' ? body['timeoutMs'] : cfg.timeoutMs,
      }, cfg.allowedRoots)
      totalServed += 1
      emit()
      // 任务本身失败（非零退出）不是 HTTP 错误 —— 调用方要拿到文本与退出码自己判断
      send(res, 200, result)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      lastError = msg
      emit()
      send(res, 400, { error: msg })
    }
    return
  }

  send(res, 404, { error: `未知端点 ${req.method ?? '?'} ${path}` })
}

// ─────────────────────────────────────────────────────────────────────────────
// 生命周期
// ─────────────────────────────────────────────────────────────────────────────

export function status(): BridgeStatus {
  const cfg = loadConfig().bridge
  const addr = server?.address()
  const port = addr !== null && addr !== undefined && typeof addr === 'object' ? addr.port : null
  return {
    running: server !== null,
    port,
    token: ensureToken(),
    inflight: runner.inflightCount(),
    totalServed,
    lastError,
    mcpCommand: port === null
      ? '（桥接未启动）'
      : `claude mcp add dsh --env KRILL_BRIDGE=http://127.0.0.1:${String(port)} `
        + `--env KRILL_TOKEN=${ensureToken()} -- node <Krill.app>/Contents/Resources/bridge-mcp/index.mjs`,
  }
}

export function start(): Promise<BridgeStatus> {
  const cfg = loadConfig().bridge
  if (server !== null) return Promise.resolve(status())
  if (!cfg.enabled) throw new Error('桥接接口未启用')

  return new Promise((resolve, reject) => {
    const s = createServer((req, res) => {
      void handle(req, res).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e)
        lastError = msg
        log(`桥接请求处理失败：${msg}`, 'stderr')
        try { send(res, 500, { error: msg }) } catch { /* 响应已发出 */ }
      })
    })
    s.on('error', (e) => {
      lastError = e.message
      server = null
      emit()
      reject(new Error(`桥接服务启动失败：${e.message}`))
    })
    // 只绑回环 —— 绝不监听 0.0.0.0
    s.listen(cfg.port, '127.0.0.1', () => {
      server = s
      lastError = null
      const addr = s.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : cfg.port
      log(`桥接接口已启动：http://127.0.0.1:${String(port)}（仅回环，需 Bearer token）`)
      emit()
      resolve(status())
    })
  })
}

export function stop(): void {
  runner.killAll()
  if (server === null) return
  server.close()
  server = null
  log('桥接接口已停止')
  emit()
}

/** 按配置决定起停 —— 面板改开关后调这个。 */
export async function reconcile(): Promise<BridgeStatus> {
  const cfg = loadConfig().bridge
  if (cfg.enabled && server === null) return start()
  if (!cfg.enabled && server !== null) stop()
  return status()
}
