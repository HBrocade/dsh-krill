/**
 * 识图（vision）的配置入口。
 *
 * 配置落在 dsh 自己的 `~/.dsh/settings.yaml` 的 `vision:` 段 —— 不另起一份，
 * 免得两处配置各说各话。用 yaml 的 Document API 读写，保留用户在文件里写的注释
 * 与格式：这个文件是用户手改过的，整份重写等于把他的批注抹掉。
 *
 * 为什么需要一个入口：配错模型时的报错是
 *   404 model 'qwen3.8:27b-mtp-q8_0' not found
 * 而正确答案（本机装了哪些、哪些能识图）只有 Ollama 知道。让人对着这条报错去
 * 手改 YAML，等于要他自己去猜一个字符串。
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parseDocument } from 'yaml'
import { log } from '../backend/log-ring.ts'
import type { VisionConfig, VisionState, VisionModel } from '@shared/ipc'

const OLLAMA = 'http://127.0.0.1:11434'

function settingsPath(): string {
  return join(homedir(), '.dsh', 'settings.yaml')
}

/** 读 `vision:` 段；文件不存在或没有该段时给出 mod 的默认值。 */
export function readConfig(): VisionConfig {
  const fallback: VisionConfig = { enabled: false, provider: 'ollama-vision', model: '' }
  try {
    const doc = parseDocument(readFileSync(settingsPath(), 'utf8'))
    const v = doc.get('vision') as { toJSON?: () => unknown } | undefined
    if (v === undefined) return fallback
    const raw = (typeof v.toJSON === 'function' ? v.toJSON() : v) as Record<string, unknown>
    return {
      enabled: typeof raw['enabled'] === 'boolean' ? raw['enabled'] : false,
      provider: typeof raw['provider'] === 'string' ? raw['provider'] : 'ollama-vision',
      model: typeof raw['model'] === 'string' ? raw['model'] : '',
    }
  } catch {
    return fallback
  }
}

/**
 * 写回 `vision:` 段。
 *
 * 先备份再写。这个文件里还有凭据引用、模型默认值之类的东西，写坏了 dsh 起不来 ——
 * 备份的成本是几 KB，代价不对等。
 */
export function writeConfig(next: VisionConfig): void {
  const path = settingsPath()
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const doc = parseDocument(text)
  if (existsSync(path)) copyFileSync(path, `${path}.bak-${String(Date.now())}`)

  doc.setIn(['vision', 'enabled'], next.enabled)
  doc.setIn(['vision', 'provider'], next.provider)
  doc.setIn(['vision', 'model'], next.model)
  writeFileSync(path, doc.toString(), 'utf8')
  log(`识图配置已写入：enabled=${String(next.enabled)} provider=${next.provider} model=${next.model}`)
}

interface OllamaTag { name?: unknown }

/**
 * 列出本机 Ollama 里**能识图**的模型。
 *
 * Ollama 的 `/api/show` 会上报 capabilities，含 `vision` 的才用得了 ——
 * 实测本机 9 个模型里只有 3 个能识图，其余选了也是白选。
 */
export async function listModels(): Promise<{ running: boolean; models: VisionModel[] }> {
  let names: string[]
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(6_000) })
    if (!res.ok) return { running: false, models: [] }
    const body = (await res.json()) as { models?: OllamaTag[] }
    names = (body.models ?? [])
      .map((m) => (typeof m.name === 'string' ? m.name : ''))
      .filter((n) => n !== '')
  } catch {
    return { running: false, models: [] }
  }

  // 逐个查能力。模型不多（本机 9 个），并发发出去等一轮就够
  const models = await Promise.all(names.map(async (name): Promise<VisionModel> => {
    try {
      const res = await fetch(`${OLLAMA}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: name }),
        signal: AbortSignal.timeout(8_000),
      })
      if (!res.ok) return { name, vision: false }
      const body = (await res.json()) as { capabilities?: unknown }
      const caps = Array.isArray(body.capabilities) ? body.capabilities : []
      return { name, vision: caps.includes('vision') }
    } catch {
      return { name, vision: false }
    }
  }))
  return { running: true, models }
}

export async function state(): Promise<VisionState> {
  const config = readConfig()
  const { running, models } = await listModels()
  const chosen = models.find((m) => m.name === config.model)
  return {
    config,
    ollamaRunning: running,
    models,
    // 把「配了但本机没有」单独讲清楚 —— 这正是 404 的来源
    modelMissing: config.model !== '' && running && chosen === undefined,
    modelNotVision: chosen !== undefined && !chosen.vision,
  }
}
