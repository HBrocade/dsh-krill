/**
 * 读 dsh 的会话日志。
 *
 * 日志是 `session.jsonl.zstd`，但**不是一个 zstd 流** —— dsh 每写一批就追加一个
 * 独立的 zstd 帧，一份 484KB 的会话里有 2625 帧。这件事踩过一次：Node 的
 * `zstdDecompressSync` 和 `createZstdDecompress` 都**只解第一帧就停**，读出来
 * 171 字节、一行 session 头，看起来像「这个会话什么都没记」。我照这个错误结论
 * 判断过一次问题，方向完全跑偏。
 *
 * 所以这里按帧魔数切分、逐帧解。不调外部 `zstd` 命令：那是 homebrew 装的，
 * 用户机器上不一定有，而这条路只用内置能力，实测与 CLI 输出逐字节一致。
 */
import { zstdDecompressSync } from 'node:zlib'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** zstd 帧魔数 0xFD2FB528，小端落在文件里就是 28 B5 2F FD。 */
const FRAME_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

/**
 * 解一个多帧 zstd 文件。
 *
 * 魔数有可能出现在压缩数据内部，所以不能拿它硬切：从一个起点开始，先试到下一个
 * 起点，解不出来就把边界往后挪一个，直到解成功。误判的魔数会被自然吸收进帧体。
 */
export interface DecodeResult {
  text: string
  /** 已成功消费到的字节位置。下次从这里接着解即可 —— 日志只追加，不重写。 */
  consumed: number
}

/**
 * 从 `from` 字节处往后解。
 *
 * 支持增量是因为会话日志只会追加：一个 7.4MB 的会话全量解要 618ms，而它正在被
 * 写的时候每次追加都会让「按 mtime 缓存」失效 —— 流式回答期间就会变成每 600ms
 * 卡半秒多。只解新增的那几帧，开销就与新数据量成正比，与文件多大无关。
 */
export function decodeMultiFrame(buf: Buffer, from = 0): DecodeResult {
  const starts: number[] = []
  for (let i = from; i + 4 <= buf.length; i += 1) {
    if (buf.compare(FRAME_MAGIC, 0, 4, i, i + 4) === 0) starts.push(i)
  }
  if (starts.length === 0) return { text: '', consumed: from }

  const parts: Buffer[] = []
  let i = 0
  let consumed = from
  while (i < starts.length) {
    let j = i + 1
    let decoded: Buffer | null = null
    let end = buf.length
    while (j <= starts.length) {
      end = j < starts.length ? starts[j]! : buf.length
      try {
        decoded = zstdDecompressSync(buf.subarray(starts[i]!, end))
        break
      } catch {
        j += 1
      }
    }
    // 解不出来就停在这里：可能是正在写入的半截帧，下次再来
    if (decoded === null) break
    parts.push(decoded)
    consumed = end
    i = j
  }
  return { text: Buffer.concat(parts).toString('utf8'), consumed }
}

export interface SessionEvent {
  type?: string
  seq?: number
  time?: number
  data?: Record<string, unknown>
}

/** 会话根目录：`~/.dsh/sessions/<把 cwd 编码过的目录名>/session-<uuid>/`。 */
export function sessionsRoot(): string {
  return join(homedir(), '.dsh', 'sessions')
}

export interface SessionFile {
  /** 会话 id（目录名） */
  id: string
  /** 该会话所属工作目录的编码目录名 */
  workspace: string
  path: string
  mtimeMs: number
  sizeBytes: number
}

/** 列出所有会话日志，按最后修改时间从新到旧。 */
export function listSessions(): SessionFile[] {
  const root = sessionsRoot()
  if (!existsSync(root)) return []
  const out: SessionFile[] = []
  for (const workspace of safeReaddir(root)) {
    const wsDir = join(root, workspace)
    for (const id of safeReaddir(wsDir)) {
      const path = join(wsDir, id, 'session.jsonl.zstd')
      try {
        const st = statSync(path)
        out.push({ id, workspace, path, mtimeMs: st.mtimeMs, sizeBytes: st.size })
      } catch { /* 不是会话目录 */ }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}

/**
 * 读某个会话从 `from` 起的事件。坏行跳过 —— 日志是追加写的，末尾可能是半行。
 *
 * @returns 事件与「已消费到哪」，后者传回下一次调用即可增量续读。
 */
export function readEventsFrom(path: string, from = 0): { events: SessionEvent[]; consumed: number } {
  let decoded: DecodeResult
  try { decoded = decodeMultiFrame(readFileSync(path), from) } catch { return { events: [], consumed: from } }
  const events: SessionEvent[] = []
  for (const line of decoded.text.split('\n')) {
    if (line.trim() === '') continue
    try { events.push(JSON.parse(line) as SessionEvent) } catch { /* 半行，跳过 */ }
  }
  return { events, consumed: decoded.consumed }
}

/** 读全部事件。 */
export function readEvents(path: string): SessionEvent[] {
  return readEventsFrom(path).events
}
