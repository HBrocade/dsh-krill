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
export function decodeMultiFrame(buf: Buffer): string {
  const starts: number[] = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf.compare(FRAME_MAGIC, 0, 4, i, i + 4) === 0) starts.push(i)
  }
  if (starts.length === 0) return ''

  const parts: Buffer[] = []
  let i = 0
  while (i < starts.length) {
    let j = i + 1
    let decoded: Buffer | null = null
    while (j <= starts.length) {
      const end = j < starts.length ? starts[j]! : buf.length
      try {
        decoded = zstdDecompressSync(buf.subarray(starts[i]!, end))
        break
      } catch {
        j += 1
      }
    }
    // 解不出来就停在这里：已读到的部分仍然有效，宁可少算也不要抛
    if (decoded === null) break
    parts.push(decoded)
    i = j
  }
  return Buffer.concat(parts).toString('utf8')
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

/** 读并解析一个会话的全部事件。坏行跳过 —— 日志是追加写的，末尾可能是半行。 */
export function readEvents(path: string): SessionEvent[] {
  let text: string
  try { text = decodeMultiFrame(readFileSync(path)) } catch { return [] }
  const events: SessionEvent[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try { events.push(JSON.parse(line) as SessionEvent) } catch { /* 半行，跳过 */ }
  }
  return events
}
