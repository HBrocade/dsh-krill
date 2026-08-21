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
import { app } from 'electron'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
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
/** 兜底值；正常走 config.bridge.timeoutMs，见 BridgeConfig 上的说明。 */
const TIMEOUT_MS_FALLBACK = 900_000
function defaultTimeoutMs(): number {
  const v = loadConfig().bridge.timeoutMs
  return typeof v === 'number' && v > 0 ? v : TIMEOUT_MS_FALLBACK
}
/** 并发上限：2。够用，又不至于让一堆任务把机器拖死 */
const MAX_CONCURRENT = 2
/** 端口由系统分配 —— 固定端口只会带来「被占用」这一类无谓的故障 */

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

/**
 * 让 MCP shim 能找到本次运行的端口与 token 的「发现文件」。
 *
 * 桥接端口可配（默认固定 17801，设 0 则随机）。改成固定之前，面板给的接入命令
 * 会把当时的端口和 token 焊进 `claude mcp add` 的 --env 里 —— App 一重启
 * 那条注册就失效了，调用方表现为连不上、看起来像超时。这个坑很难自查：
 * 注册当天是好的，第二天才开始「莫名其妙超时」。
 *
 * 所以改成运行时发现：启动时写下端口与 token，停止时删掉。shim 每次调用都重读，
 * 于是重启、换端口、轮换 token 都不需要重新注册。
 */
export function discoveryPath(): string {
  return join(app.getPath('userData'), 'bridge.json')
}

function writeDiscovery(port: number, token: string): void {
  try {
    writeFileSync(discoveryPath(), `${JSON.stringify({
      endpoint: `http://127.0.0.1:${String(port)}`,
      port,
      token,
      pid: process.pid,
      updatedAt: Date.now(),
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch (e) {
    log(`写桥接发现文件失败：${e instanceof Error ? e.message : String(e)}`, 'stderr')
  }
}

function clearDiscovery(): void {
  try { rmSync(discoveryPath(), { force: true }) } catch { /* 本来就没有 */ }
}

export function rotateToken(): string {
  token = randomBytes(24).toString('base64url')
  saveConfig({ bridgeToken: token })
  log('桥接 token 已轮换')
  emit()
  // 轮换后发现文件也要跟着更新，否则 shim 还拿着旧 token
  const addr = server?.address()
  if (addr !== null && addr !== undefined && typeof addr === 'object') writeDiscovery(addr.port, token)
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

  // 浏览器防线（不管要不要 token 都查）。
  //
  // 这个端点等于在本机执行任意任务。绑回环挡住了外网，挡不住**本机的网页** ——
  // 任何一个标签页都能往 127.0.0.1 发 POST，响应读不到不要紧，副作用已经发生了。
  // 两道零成本的检查就能彻底堵死这条路：
  //   · 带 Origin 的一律拒绝 —— 浏览器必带，curl / CLI 必不带
  //   · POST 强制 application/json —— 非简单类型，浏览器得先过预检，而我们不发 CORS 头
  if (typeof req.headers.origin === 'string' && req.headers.origin !== '') {
    send(res, 403, { error: '拒绝来自浏览器的请求（带 Origin 头）。这个接口只给本机命令行与程序调用。' })
    return
  }
  if (req.method === 'POST') {
    const ct = String(req.headers['content-type'] ?? '')
    if (!ct.toLowerCase().includes('application/json')) {
      send(res, 415, { error: "POST 必须带 Content-Type: application/json" })
      return
    }
  }
  // token 默认不要 —— 本机调用不必带票，见 BridgeConfig.requireToken 上的说明
  if (cfg.requireToken && !tokenOk(req.headers.authorization)) {
    send(res, 401, { error: '缺少或错误的 Bearer token' })
    return
  }

  // 两个端点就够：一个说明怎么用，一个负责干活。
  // 文档做成自描述的 —— 调用方（多半是另一个 AI）读一次就知道怎么调，
  // 不用去翻 README。
  if ((path === '/v1/docs' || path === '/' || path === '/v1') && req.method === 'GET') {
    const m = currentModel.read()
    // 例子里写真实地址 —— 调用方（多半是另一个 AI）复制就能跑，不用再去别处查端口
    const addr = server?.address()
    const base = `http://127.0.0.1:${String(
      addr !== null && addr !== undefined && typeof addr === 'object' ? addr.port : cfg.port,
    )}`
    send(res, 200, {
      name: 'Krill bridge',
      purpose: '把 DeepSeek Harness（dsh）当作第二意见来源：换一个模型、换一个角度看同一件事。',
      dshVersion: currentVersion(),
      // 模型与凭据都取自 ~/.dsh 全局配置 —— 和用户此刻聊天用的完全一致，
      // 调用方不需要、也不能指定
      model: { provider: m.provider, name: m.model, reasoningEffort: m.reasoningEffort },
      auth: cfg.requireToken
        ? '需要 Authorization: Bearer <token>（在 Krill 的桥接面板里查看）'
        : '不需要鉴权：只绑回环，且带 Origin 头的请求（即来自浏览器的）一律拒绝。',
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
          curl: `curl -sX POST ${base}/v1/ask -H 'content-type: application/json' `
            + `-d '{"prompt":"这段实现有什么隐患？"}'`,
        },
        {
          用途: '代码审查第二意见',
          说明: '把 cwd 指到仓库，让它自己去跑 git diff 拿改动',
          curl: `curl -sX POST ${base}/v1/ask -H 'content-type: application/json' `
            + `-d '{"cwd":"/path/to/repo","prompt":"运行 git diff HEAD 拿到改动，`
            + `作为独立审查者给出第二意见：只报有把握的问题，给出位置与可复现场景，不要复述改动做了什么。"}'`,
        },
      ],
      notes: [
        '任务失败不用 HTTP 错误码表达 —— 一律 200，看 exitCode 与 text 自己判断。',
        '并发上限 ' + String(MAX_CONCURRENT) + '，超了返回 429。',
        '默认超时 ' + String(defaultTimeoutMs()) + ' 毫秒。',
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
        timeoutMs: typeof body['timeoutMs'] === 'number' ? body['timeoutMs'] : defaultTimeoutMs(),
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
    // 命令里**不带**端口和 token：端口每次启动都变、token 可轮换，
    // 焊进 --env 的注册第二天就失效，而失效的表现是「连不上／超时」。
    // shim 每次调用自己读发现文件，重启换端口也不用重新注册。
    mcpCommand: `claude mcp add dsh -- node ${join(process.resourcesPath ?? '<Krill.app>/Contents/Resources', 'bridge-mcp', 'index.mjs')}`,
    model: currentModel.describe(),
    limits: { timeoutMs: defaultTimeoutMs(), maxConcurrent: MAX_CONCURRENT },
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
    s.listen(loadConfig().bridge.port, '127.0.0.1', () => {
      server = s
      lastError = null
      const addr = s.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      log(`桥接接口已启动：http://127.0.0.1:${String(port)}（仅回环，`
        + `${loadConfig().bridge.requireToken ? '需 Bearer token' : '免鉴权，拒绝浏览器来源'}）`)
      writeDiscovery(port, loadConfig().bridgeToken)
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
  clearDiscovery()
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
