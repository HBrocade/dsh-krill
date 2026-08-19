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
    port: 0,
    allowedRoots: [],
    timeoutMs: 300_000,
    maxConcurrent: 2,
  },
  bridgeToken: '',
  lastPanel: 'chat',
}

let cache: DesktopConfig | null = null

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

/** 逐字段合并，缺字段用默认值补 —— 老版本配置文件升级后不至于缺键。 */
function merge(raw: unknown): DesktopConfig {
  if (raw === null || typeof raw !== 'object') return { ...DEFAULTS }
  const r = raw as Partial<DesktopConfig>
  return {
    ...DEFAULTS,
    ...r,
    bridge: { ...DEFAULTS.bridge, ...(r.bridge ?? {}) },
  }
}

export function loadConfig(): DesktopConfig {
  if (cache !== null) return cache
  try {
    cache = merge(JSON.parse(readFileSync(configPath(), 'utf8')))
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

/**
 * 写配置。先写临时文件再 rename —— 原子替换，避免进程在写一半时被杀掉
 * 留下半截 JSON，那会让下次启动整份配置退回默认值。
 */
export function saveConfig(patch: Partial<DesktopConfig>): DesktopConfig {
  const next = merge({ ...loadConfig(), ...patch })
  cache = next
  const target = configPath()
  const tmp = `${target}.tmp`
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, target)
  return next
}

export function getDefaults(): DesktopConfig {
  return { ...DEFAULTS, bridge: { ...DEFAULTS.bridge } }
}
