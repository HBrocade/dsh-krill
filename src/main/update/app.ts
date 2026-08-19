/**
 * 桌面 App 自更新（electron-updater）。
 *
 * 发布渠道**默认未配置**：`config.json` 的 `appUpdateFeedUrl` 为空时，
 * 面板显示「未配置发布渠道」，不报错、不弹窗、不写错误日志。
 * 自更新是可选能力，没配就该安静，而不是每 6 小时抛一次异常。
 *
 * 开发模式下 electron-updater 找不到 `app-update.yml` 会抛 —— 同样静默降级。
 */
import { app } from 'electron'
import { log } from '../backend/log-ring.ts'
import { loadConfig } from '../config/store.ts'
import type { AppUpdate } from '@shared/ipc'

type Updater = typeof import('electron-updater').autoUpdater

let updater: Updater | null = null
let state: AppUpdate = {
  configured: false,
  current: '0.0.0',
  latest: null,
  status: 'idle',
  progressPercent: null,
  error: null,
}
let onChange: (() => void) | null = null

function patch(next: Partial<AppUpdate>): void {
  state = { ...state, ...next }
  onChange?.()
}

export function subscribe(fn: () => void): void { onChange = fn }
export function snapshot(): AppUpdate { return { ...state, current: app.getVersion() } }

/** 未配置 feedUrl，或跑在开发模式下，就不初始化 —— 两种情况都属于「本来就不该更新」。 */
function usable(): boolean {
  return loadConfig().appUpdateFeedUrl.trim() !== '' && app.isPackaged
}

async function ensure(): Promise<Updater | null> {
  if (!usable()) return null
  if (updater !== null) return updater
  const mod = await import('electron-updater')
  const u = mod.autoUpdater
  u.autoDownload = false            // 下载由用户点，不偷偷占带宽
  u.autoInstallOnAppQuit = false    // 安装同样要用户确认
  u.setFeedURL(loadConfig().appUpdateFeedUrl)

  u.on('update-available', (info) => { patch({ status: 'available', latest: info.version, error: null }) })
  u.on('update-not-available', () => { patch({ status: 'idle', latest: null, error: null }) })
  u.on('download-progress', (p) => { patch({ status: 'downloading', progressPercent: Math.round(p.percent) }) })
  u.on('update-downloaded', (info) => { patch({ status: 'downloaded', latest: info.version, progressPercent: 100 }) })
  u.on('error', (err) => {
    log(`自更新失败：${err.message}`, 'stderr')
    patch({ status: 'error', error: err.message })
  })
  updater = u
  return u
}

export async function check(): Promise<AppUpdate> {
  patch({ configured: usable(), current: app.getVersion() })
  const u = await ensure()
  if (u === null) {
    // 未配置：安静地保持 idle，面板据 configured=false 显示「未配置发布渠道」
    patch({ status: 'idle', error: null })
    return snapshot()
  }
  try {
    patch({ status: 'checking', error: null })
    await u.checkForUpdates()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log(`自更新检查失败：${msg}`, 'stderr')
    patch({ status: 'error', error: msg })
  }
  return snapshot()
}

export async function download(): Promise<void> {
  const u = await ensure()
  if (u === null) throw new Error('未配置发布渠道，无法下载更新')
  if (state.status !== 'available') throw new Error('当前没有可下载的更新')
  patch({ status: 'downloading', progressPercent: 0 })
  await u.downloadUpdate()
}

export async function install(): Promise<void> {
  const u = await ensure()
  if (u === null) throw new Error('未配置发布渠道')
  if (state.status !== 'downloaded') throw new Error('更新尚未下载完成')
  log('安装更新并重启')
  u.quitAndInstall()
}
