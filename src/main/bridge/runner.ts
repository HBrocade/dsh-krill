/**
 * 一次性任务执行器：spawn `dsh --profile headless "<task>"`。
 *
 * headless 是官方的程序化入口：提交任务 → 等待静默 → 把最后一条非空
 * assistant 文本写 stdout → 退出码 0/1 → 不开监听端口。
 * 这正是「让外部工具把 dsh 当第二意见」需要的形态。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { locateDsh } from '../backend/locate.ts'
import { log } from '../backend/log-ring.ts'

export interface RunRequest {
  prompt: string
  cwd?: string
  timeoutMs?: number
}

export interface RunResult {
  text: string
  exitCode: number
  durationMs: number
  /** 被超时掐掉的 */
  timedOut: boolean
  /** stderr 尾部，失败时给调用方一点线索 */
  stderrTail: string
}

/**
 * 校验工作目录。
 *
 * @param cwd - 请求里传的目录
 * @param allowedRoots - 白名单；**空数组表示不限制到特定根目录**，
 *   但仍要求目录真实存在。这个接口能在本机跑任务，目录必须校验。
 */
export function resolveCwd(cwd: string | undefined, allowedRoots: readonly string[]): string {
  if (cwd === undefined || cwd.trim() === '') return process.env['HOME'] ?? '/'
  const target = cwd.trim()
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new Error(`工作目录不存在或不是目录：${target}`)
  }
  if (allowedRoots.length === 0) return target
  const ok = allowedRoots.some((root) => {
    const r = root.endsWith('/') ? root : `${root}/`
    return target === root || target.startsWith(r)
  })
  if (!ok) {
    throw new Error(`工作目录不在白名单内：${target}（允许的根目录：${allowedRoots.join('、')}）`)
  }
  return target
}

const running = new Set<ChildProcess>()

export function inflightCount(): number { return running.size }

/** 退出时把还在跑的任务一并收掉，别留孤儿进程。 */
export function killAll(): void {
  for (const p of running) {
    try { p.kill('SIGTERM') } catch { /* 已退出 */ }
  }
}

export function run(req: RunRequest, allowedRoots: readonly string[]): Promise<RunResult> {
  const located = locateDsh()
  if (located === null) throw new Error('找不到 dsh，无法执行任务')
  const task = req.prompt.trim()
  if (task === '') throw new Error('prompt 不能为空')

  const cwd = resolveCwd(req.cwd, allowedRoots)
  // 固定用 headless —— 一次性任务只有它合适，不做成可配置项徒增调用方负担
  const profile = 'headless'
  const timeoutMs = req.timeoutMs ?? 300_000
  const argv = [located.bin, '--profile', profile, task]
  const started = Date.now()

  log(`桥接任务开始：profile=${profile} cwd=${cwd} 长度=${task.length}`)

  return new Promise((resolve, reject) => {
    const proc = spawn(
      located.nodeBin,
      [...located.nodeFlags, ...argv],
      {
        cwd,
        env: { ...process.env, ...(located.needsElectronAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    running.add(proc)

    let out = ''
    let err = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { proc.kill('SIGTERM') } catch { /* 已退出 */ }
      // 宽限后强杀，避免卡死的任务永远占着并发额度
      setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* 已退出 */ } }, 5_000)
    }, timeoutMs)

    // 一次真实任务能跑七八分钟，中间一声不吭 —— 日志里加个心跳，
    // 否则「还在跑」和「卡死了」在事后完全分不出来
    const beat = setInterval(() => {
      log(`桥接任务进行中：已 ${String(Math.round((Date.now() - started) / 1000))}s`
        + `，已收到 ${String(out.length)} 字节`)
    }, 60_000)

    proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => {
      err += d.toString()
      if (err.length > 8_000) err = err.slice(-8_000)
    })
    proc.on('error', (e) => {
      clearTimeout(timer); clearInterval(beat); running.delete(proc)
      reject(new Error(`无法启动 dsh：${e.message}`))
    })
    proc.on('exit', (code, signal) => {
      clearTimeout(timer); clearInterval(beat); running.delete(proc)
      const durationMs = Date.now() - started
      // 带上 signal：dsh 收到 SIGTERM 后是干净退出的（code=0），
      // 只看 code 会把「被掐断」误读成「成功」
      log(`桥接任务结束：code=${code ?? 'null'} signal=${signal ?? '无'} `
        + `用时 ${String(Math.round(durationMs / 1000))}s`
        + (timedOut ? `（超时被掐，上限 ${String(Math.round(timeoutMs / 1000))}s）` : ''))
      resolve({
        text: out.trim(),
        exitCode: code ?? -1,
        durationMs,
        timedOut,
        stderrTail: err.trim().slice(-2_000),
      })
    })
  })
}

/**
 * 把 code review 请求组装成一段任务描述。
 *
 * 刻意写成「第二意见」的口吻 —— 这个接口的用途就是让另一个模型
 * 从不同角度看同一份改动，而不是复述已有结论。
 */
export function buildReviewPrompt(args: {
  diff?: string
  ref?: string
  focus?: string
}): string {
  const parts: string[] = [
    '你是一位独立的代码审查者，正在为另一个 AI 的工作提供第二意见。',
    '请只报告你有把握的问题，并给出具体位置与可复现的失败场景；',
    '没有把握的猜测请明确标注为猜测。不要复述改动做了什么。',
    '',
  ]
  if (args.focus !== undefined && args.focus.trim() !== '') {
    parts.push(`重点关注：${args.focus.trim()}`, '')
  }
  if (args.diff !== undefined && args.diff.trim() !== '') {
    parts.push('待审查的 diff：', '```diff', args.diff.trim(), '```')
  } else {
    const ref = args.ref !== undefined && args.ref.trim() !== '' ? args.ref.trim() : 'HEAD'
    parts.push(
      `请先在当前工作目录运行 \`git diff ${ref}\`（若无输出则试 \`git diff ${ref}~1 ${ref}\`）`,
      '拿到改动内容，然后审查它。',
    )
  }
  return parts.join('\n')
}
