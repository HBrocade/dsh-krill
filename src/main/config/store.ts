/**
 * 桌面端自身的配置（`userData/config.json`）。
 *
 * 只存桌面壳的设置。dsh 的配置（模型、凭据、会话）一律留在 `~/.dsh`，
 * 新旧 App 与浏览器版共用同一份，这里绝不复制一份出来。
 */
import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { BridgeConfig } from '@shared/ipc'

export interface DesktopConfig {
  /** 自动检查更新的间隔（小时）；<=0 关闭定时，只留手动 */
  updateIntervalHours: number
  /** electron-updater 的发布渠道。留空 = 未配置，面板显示「未配置」而非报错 */
  appUpdateFeedUrl: string
  /** 源码仓库检测目标 */
  sourceRepoPath: string
  sourceRepoRef: string
  bridge: BridgeConfig
  /** 桥接接口的 Bearer token，首次使用时随机生成 */
  bridgeToken: string
  /** 上次停留的面板，下次启动恢复 */
  lastPanel: string
}

const DEFAULTS: DesktopConfig = {
  updateIntervalHours: 6,
  appUpdateFeedUrl: '',
  sourceRepoPath: join(homedir(), 'deepseek-harness', 'dsh-source'),
  sourceRepoRef: 'origin/master',
  bridge: {
    // 对外接口默认关闭：它能在本机执行任务，必须由用户显式打开
    enabled: false,
  },
  bridgeToken: '',
  lastPanel: 'chat',
}

let cache: DesktopConfig | null = null

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

/**
 * 逐字段合并，缺字段用默认值补 —— 老版本配置文件升级后不至于缺键。
 *
 * bridge 段刻意**只保留已知键**：它曾经有 port / timeoutMs / maxConcurrent /
 * allowedRoots，后来收敛成只剩一个开关。单纯展开旧对象会把这些废弃键一直
 * 带下去，配置文件越攒越脏，看的人也搞不清哪些还生效。
 */
function merge(raw: unknown): DesktopConfig {
  if (raw === null || typeof raw !== 'object') return { ...DEFAULTS }
  const r = raw as Partial<DesktopConfig>
  const bridgeRaw = (r.bridge ?? {}) as Record<string, unknown>
  const bridge: DesktopConfig['bridge'] = {
    enabled: typeof bridgeRaw['enabled'] === 'boolean' ? bridgeRaw['enabled'] : DEFAULTS.bridge.enabled,
  }
  return { ...DEFAULTS, ...r, bridge }
}

export function loadConfig(): DesktopConfig {
  if (cache !== null) return cache
  let raw: unknown = null
  try {
    raw = JSON.parse(readFileSync(configPath(), 'utf8'))
  } catch {
    cache = { ...DEFAULTS }
    return cache
  }
  const merged = merge(raw)
  cache = merged
  // 读到的和规范化后的不一致（多了废弃键、少了新键），就自愈重写一次。
  // 否则废弃键要等到下一次恰好有人写配置才会被清掉，中间一直脏着。
  if (JSON.stringify(raw) !== JSON.stringify(merged)) {
    try { writeAtomic(merged) } catch { /* 只是清理，失败不影响运行 */ }
  }
  return merged
}

/** 原子写：先写临时文件再 rename，避免写一半被杀留下半截 JSON。 */
function writeAtomic(cfg: DesktopConfig): void {
  const target = configPath()
  const tmp = `${target}.tmp`
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
  renameSync(tmp, target)
}

/**
 * 写配置。先写临时文件再 rename —— 原子替换，避免进程在写一半时被杀掉
 * 留下半截 JSON，那会让下次启动整份配置退回默认值。
 */
export function saveConfig(patch: Partial<DesktopConfig>): DesktopConfig {
  const next = merge({ ...loadConfig(), ...patch })
  cache = next
  writeAtomic(next)
  return next
}

export function getDefaults(): DesktopConfig {
  return { ...DEFAULTS, bridge: { ...DEFAULTS.bridge } }
}
