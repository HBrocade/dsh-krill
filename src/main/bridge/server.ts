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
import * as runner from './runner.ts'
import * as currentModel from './current-model.ts'
import type { BridgeStatus } from '@shared/ipc'

/** 请求体上限：diff 可能不小，但 2MB 已经远超正常 code review 的量 */
const MAX_BODY = 2 * 1024 * 1024
/** 单个任务超时：5 分钟。固定值 —— 不做成配置项 */
const TIMEOUT_MS = 300_000
/** 并发上限：2。够用，又不至于让一堆任务把机器拖死 */
const MAX_CONCURRENT = 2
/** 端口由系统分配 —— 固定端口只会带来「被占用」这一类无谓的故障 */
const PORT = 0

let server: Server | null = null
let token = ''
let totalServed = 0
/** 仅本次运行强制启用（--dev-bridge），不落盘 —— 默认关闭是安全设计的一部分 */
let forced = false
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

  // 两个端点就够：一个说明怎么用，一个负责干活。
  // 文档做成自描述的 —— 调用方（多半是另一个 AI）读一次就知道怎么调，
  // 不用去翻 README。
  if ((path === '/v1/docs' || path === '/' || path === '/v1') && req.method === 'GET') {
    const m = currentModel.read()
    send(res, 200, {
      name: 'Krill bridge',
      purpose: '把 DeepSeek Harness（dsh）当作第二意见来源：换一个模型、换一个角度看同一件事。',
      dshVersion: currentVersion(),
      // 模型与凭据都取自 ~/.dsh 全局配置 —— 和用户此刻聊天用的完全一致，
      // 调用方不需要、也不能指定
      model: { provider: m.provider, name: m.model, reasoningEffort: m.reasoningEffort },
      auth: '所有请求都要带 Authorization: Bearer <token>',
      endpoints: {
        'GET /v1/docs': '本文档',
        'POST /v1/ask': {
          body: {
            prompt: '必填。要交给 dsh 的任务或问题。',
            cwd: '选填。工作目录绝对路径；dsh 会在这个目录里执行，可读写文件、跑 git 等。',
          },
          returns: {
            text: 'dsh 的回答（最后一条非空 assistant 文本）',
            exitCode: '0 为正常；非零表示任务失败，但 HTTP 仍是 200',
            durationMs: '耗时',
            timedOut: '是否被超时中止',
            stderrTail: '失败时的 stderr 尾部',
          },
        },
      },
      examples: [
        {
          用途: '问一个独立问题',
          curl: `curl -X POST $BRIDGE/v1/ask -H "Authorization: Bearer $TOKEN" `
            + `-H 'content-type: application/json' -d '{"prompt":"这段实现有什么隐患？"}'`,
        },
        {
          用途: '代码审查第二意见',
          说明: '把 cwd 指到仓库，让它自己去跑 git diff 拿改动',
          curl: `curl -X POST $BRIDGE/v1/ask -H "Authorization: Bearer $TOKEN" `
            + `-H 'content-type: application/json' `
            + `-d '{"cwd":"/path/to/repo","prompt":"运行 git diff HEAD 拿到改动，`
            + `作为独立审查者给出第二意见：只报有把握的问题，给出位置与可复现场景，不要复述改动做了什么。"}'`,
        },
      ],
      notes: [
        '任务失败不用 HTTP 错误码表达 —— 一律 200，看 exitCode 与 text 自己判断。',
        '并发上限 ' + String(MAX_CONCURRENT) + '，超了返回 429。',
        '默认超时 ' + String(TIMEOUT_MS) + ' 毫秒。',
        'cwd 不限根目录，但必须是真实存在的目录。',
      ],
      runtime: { inflight: runner.inflightCount(), totalServed },
    })
    return
  }

  if (path === '/v1/ask' && req.method === 'POST') {
    if (runner.inflightCount() >= MAX_CONCURRENT) {
      send(res, 429, { error: `并发已满（上限 ${String(MAX_CONCURRENT)}），稍后再试` })
      return
    }
    let body: Record<string, unknown>
    try {
      body = (await readBody(req)) as Record<string, unknown>
    } catch (e) {
      send(res, 400, { error: e instanceof Error ? e.message : String(e) })
      return
    }

    try {
      const result = await runner.run({
        prompt: String(body['prompt'] ?? ''),
        cwd: typeof body['cwd'] === 'string' ? body['cwd'] : undefined,
        timeoutMs: typeof body['timeoutMs'] === 'number' ? body['timeoutMs'] : TIMEOUT_MS,
      }, [])
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
    model: currentModel.describe(),
    limits: { timeoutMs: TIMEOUT_MS, maxConcurrent: MAX_CONCURRENT },
  }
}

export function forceEnable(): void { forced = true }

export function start(): Promise<BridgeStatus> {
  const cfg = loadConfig().bridge
  if (server !== null) return Promise.resolve(status())
  if (!cfg.enabled && !forced) throw new Error('桥接接口未启用')

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
    s.listen(PORT, '127.0.0.1', () => {
      server = s
      lastError = null
      const addr = s.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : PORT
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
  if (!cfg.enabled && server !== null) {
    // 用户显式关闭时，连开发开关的强制启用一并解除 ——
    // 否则点了「关闭接口」服务还在跑，按钮会一直翻转不过来
    forced = false
    stop()
  }
  return status()
}
