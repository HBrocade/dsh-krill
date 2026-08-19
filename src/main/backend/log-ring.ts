/**
 * 日志：内存环形缓冲 + 落盘。
 *
 * 旧版只落盘，日志面板要实时看就得读文件、还得处理轮转，很别扭。
 * 这里内存里留最近 N 行供面板即时拉取与订阅，同时照旧落盘留档。
 */
import { app } from 'electron'
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import type { LogLine, LogLevel } from '@shared/ipc'

const CAPACITY = 2000

const buffer: LogLine[] = []
let seq = 0
let stream: WriteStream | null = null
const listeners = new Set<(line: LogLine) => void>()

export function logDir(): string {
  return join(app.getPath('userData'), 'logs')
}

export function openLog(): void {
  if (stream !== null) return
  try {
    const dir = logDir()
    mkdirSync(dir, { recursive: true })
    stream = createWriteStream(join(dir, 'app.log'), { flags: 'a' })
  } catch {
    // 落盘失败不该让 App 起不来；内存缓冲仍然可用，面板照常能看
    stream = null
  }
}

export function closeLog(): void {
  try { stream?.end() } catch { /* 退出路径，忽略 */ }
  stream = null
}

export function log(text: string, level: LogLevel = 'app'): LogLine {
  seq += 1
  const line: LogLine = { seq, ts: Date.now(), level, text }
  buffer.push(line)
  if (buffer.length > CAPACITY) buffer.splice(0, buffer.length - CAPACITY)
  const stamped = `[${new Date(line.ts).toISOString()}] ${level === 'app' ? '' : `[${level}] `}${text}\n`
  try { stream?.write(stamped) } catch { /* 磁盘满等，不影响运行 */ }
  if (level === 'stderr') console.error(stamped.trimEnd())
  else console.log(stamped.trimEnd())
  for (const l of listeners) {
    try { l(line) } catch { /* 单个订阅者出错不影响其他 */ }
  }
  return line
}

/** 取最近 limit 行（含全部时返回全部）。 */
export function tail(limit: number): LogLine[] {
  if (limit <= 0) return []
  return buffer.slice(-limit)
}

export function onLine(listener: (line: LogLine) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
