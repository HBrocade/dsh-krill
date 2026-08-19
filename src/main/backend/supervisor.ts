/**
 * 后端子进程主管：spawn `dsh --profile web --port 0`，看住它的一生。
 *
 * 语义沿用旧版（那部分是对的）：stdout 解析就绪 URL → HTTP 200 轮询 →
 * 退出时 SIGTERM → 宽限 → SIGKILL。这里做的是结构化、类型化，并把状态
 * 变化广播出去供界面与托盘订阅。
 *
 * 一个刻意的改动：崩溃重启不再弹模态对话框打断用户，改为自动重启并把
 * 情况写进状态与日志 —— 弹窗会挡住正在看的内容，而重启本身是可自愈的。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { request } from 'node:http'
import { locateDsh, webProfileFlags, type LocatedDsh } from './locate.ts'
import { log } from './log-ring.ts'
import type { BackendStatus, BackendPhase } from '@shared/ipc'

const READY_TIMEOUT_MS = 90_000
const PROBE_INTERVAL_MS = 400
const KILL_GRACE_MS = 5_000
const MAX_RESTARTS = 3
/** 连续崩溃计数的衰减窗口：跑够这么久算「稳定过」，重置重启次数 */
const STABLE_RESET_MS = 120_000

let child: ChildProcess | null = null
let located: LocatedDsh | null = null
let status: BackendStatus = {
  phase: 'idle', url: null, port: null, dshBin: null, dshVersion: null,
  dshSource: null, pid: null, restarts: 0, message: null,
}
let quitting = false
let readyAt = 0
const listeners = new Set<(s: BackendStatus) => void>()

export function getStatus(): BackendStatus { return { ...status } }

export function onStatus(fn: (s: BackendStatus) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function setStatus(patch: Partial<BackendStatus>): void {
  status = { ...status, ...patch }
  for (const fn of listeners) {
    try { fn({ ...status }) } catch { /* 单个订阅者出错不影响其他 */ }
  }
}

function phase(p: BackendPhase, message: string | null = null): void {
  setStatus({ phase: p, message })
}

/** 探一次 URL 是否已 200。失败一律 resolve(false)，不抛。 */
function probe(url: string, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(url, { method: 'GET' }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false) })
    req.end()
  })
}

async function waitReady(url: string, deadline: number): Promise<void> {
  for (;;) {
    if (quitting) throw new Error('应用正在退出')
    if (await probe(url)) return
    if (Date.now() > deadline) throw new Error(`后端就绪探测超时：${url}`)
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS))
  }
}

/**
 * 启动后端。已在运行则直接返回当前地址。
 * @returns 就绪的 http://127.0.0.1:<port>
 */
export async function start(): Promise<string> {
  if (child !== null && status.url !== null) return status.url

  phase('locating')
  const found = locateDsh()
  if (found === null) {
    const msg = '找不到 dsh。请先 npm run embed 内嵌 CLI，或用 DSH_BIN 环境变量指定入口。'
    phase('failed', msg)
    throw new Error(msg)
  }
  located = found
  setStatus({ dshBin: found.bin, dshVersion: found.version, dshSource: found.source })

  const args = [found.bin, '--profile', 'web', '--port', '0', ...webProfileFlags(found.bin)]
  log(`spawn 后端：${found.nodeBin} ${[...found.nodeFlags, ...args].join(' ')}（来源 ${found.source}）`)
  phase('starting')

  const proc = spawn(found.nodeBin, [...found.nodeFlags, ...args], {
    env: {
      ...process.env,
      ...(found.needsElectronAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: false,
  })
  child = proc
  setStatus({ pid: proc.pid ?? null })

  return new Promise<string>((resolve, reject) => {
    let settled = false
    let urlSeen: string | null = null
    const recent: string[] = []
    const deadline = Date.now() + READY_TIMEOUT_MS

    const finish = (err: Error | null, url?: string): void => {
      if (settled) return
      settled = true
      if (err !== null) { phase('failed', err.message); reject(err) }
      else {
        readyAt = Date.now()
        setStatus({ phase: 'ready', url: url ?? null, port: url === undefined ? null : Number(new URL(url).port), message: null })
        resolve(url as string)
      }
    }

    const remember = (line: string): void => {
      recent.push(line)
      if (recent.length > 30) recent.shift()
    }

    if (proc.stdout !== null) {
      createInterface({ input: proc.stdout }).on('line', (line) => {
        remember(line)
        log(line, 'stdout')
        const m = /https?:\/\/127\.0\.0\.1:(\d+)/.exec(line)
        if (m !== null && urlSeen === null) {
          urlSeen = m[0]
          waitReady(m[0], deadline).then(() => finish(null, m[0]!)).catch((e: Error) => finish(e))
        }
      })
    }
    if (proc.stderr !== null) {
      createInterface({ input: proc.stderr }).on('line', (line) => {
        remember(line)
        log(line, 'stderr')
      })
    }

    proc.on('error', (err) => {
      log(`后端启动失败：${err.message}`, 'stderr')
      finish(new Error(`后端启动失败：${err.message}`))
    })

    proc.on('exit', (code, signal) => {
      log(`后端退出 code=${code} signal=${signal}`)
      const wasReady = status.phase === 'ready'
      child = null
      setStatus({ pid: null, url: null, port: null })
      if (!settled) {
        finish(new Error(
          `后端进程提前退出（code=${code}, signal=${signal}）。最近输出：\n${recent.slice(-10).join('\n')}`,
        ))
        return
      }
      if (quitting) return
      if (wasReady) void handleCrash(code, signal)
    })

    setTimeout(() => {
      if (!settled) {
        finish(new Error(
          `等待后端就绪超时（${READY_TIMEOUT_MS / 1000}s）。最近输出：\n${recent.slice(-10).join('\n')}`,
        ))
      }
    }, READY_TIMEOUT_MS)
  })
}

/**
 * 崩溃自愈：自动重启，不弹模态框打断用户。
 * 稳定运行超过 STABLE_RESET_MS 视为「这次是偶发」，重置计数。
 */
async function handleCrash(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
  if (readyAt > 0 && Date.now() - readyAt > STABLE_RESET_MS) {
    setStatus({ restarts: 0 })
  }
  if (status.restarts >= MAX_RESTARTS) {
    const msg = `后端连续 ${MAX_RESTARTS} 次异常退出（最后一次 code=${code}, signal=${signal}），已停止自动重启。可在日志面板查看原因后手动重启。`
    log(msg, 'stderr')
    phase('crashed', msg)
    return
  }
  setStatus({ restarts: status.restarts + 1 })
  log(`后端异常退出（code=${code}, signal=${signal}），第 ${status.restarts} 次自动重启`)
  phase('restarting')
  try {
    await start()
  } catch (e) {
    phase('crashed', e instanceof Error ? e.message : String(e))
  }
}

/** 优雅停止：SIGTERM → 宽限 → SIGKILL。 */
export function stop(): void {
  const proc = child
  if (proc === null || proc.killed) return
  log('停止后端（SIGTERM）')
  try { proc.kill('SIGTERM') } catch { /* 已退出 */ }
  setTimeout(() => {
    if (proc.killed) return
    log('后端未在宽限期内退出，强制 SIGKILL', 'stderr')
    try { proc.kill('SIGKILL') } catch { /* 已退出 */ }
  }, KILL_GRACE_MS)
}

/** 手动重启：停掉旧的，等它真的退出再起新的。 */
export async function restart(): Promise<string> {
  setStatus({ restarts: 0 })
  const proc = child
  if (proc !== null) {
    phase('restarting')
    await new Promise<void>((resolve) => {
      const done = (): void => resolve()
      proc.once('exit', done)
      stop()
      // 兜底：进程已经是僵尸、exit 不会再来时不要永远卡住
      setTimeout(done, KILL_GRACE_MS + 1_000)
    })
    child = null
  }
  return start()
}

export function markQuitting(): void {
  quitting = true
}

export function currentDsh(): LocatedDsh | null { return located }
