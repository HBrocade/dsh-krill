/**
 * 托盘：后端状态一眼可见 + 常用动作直达。
 *
 * 标题只在有可升级项时挂角标 —— 托盘是常驻可见的，无事时应该安静。
 */
import { Tray, Menu, nativeImage, app } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { createWindow, focusWindow, getShellContents } from './shell-window.ts'
import { getStatus, restart } from '../backend/supervisor.ts'
import type { BackendStatus, UpdateReport } from '@shared/ipc'

let tray: Tray | null = null
let lastReport: UpdateReport | null = null

const PHASE_LABEL: Record<BackendStatus['phase'], string> = {
  idle: '未启动',
  locating: '正在定位 dsh…',
  starting: '正在启动…',
  ready: '运行中',
  restarting: '正在重启…',
  crashed: '已崩溃（自动重启已停止）',
  failed: '启动失败',
}

function iconPath(): string {
  const packed = join(process.resourcesPath ?? '', 'build', 'trayTemplate.png')
  if (existsSync(packed)) return packed
  return join(app.getAppPath(), 'build', 'trayTemplate.png')
}

function goto(panel: string): void {
  createWindow()
  focusWindow()
  getShellContents()?.send('nav:goto', { panel })
}

/** 可升级项总数，决定托盘要不要挂角标。 */
function pendingCount(r: UpdateReport | null): number {
  if (r === null) return 0
  let n = 0
  if (r.cli.upgradable) n += 1
  n += r.plugins.filter((p) => p.upgradable).length
  if (r.app.status === 'available' || r.app.status === 'downloaded') n += 1
  if (r.sourceRepo.exists && r.sourceRepo.behind > 0) n += 1
  return n
}

export function refreshTray(): void {
  if (tray === null) return
  const s = getStatus()
  const pending = pendingCount(lastReport)

  const menu = Menu.buildFromTemplate([
    { label: `后端：${PHASE_LABEL[s.phase]}${s.port !== null ? `  :${s.port}` : ''}`, enabled: false },
    ...(s.dshVersion !== null ? [{ label: `dsh ${s.dshVersion}（${s.dshSource}）`, enabled: false }] : []),
    ...(s.message !== null ? [{ label: s.message.slice(0, 80), enabled: false }] : []),
    { type: 'separator' as const },
    { label: '打开主窗口', click: () => { createWindow(); focusWindow() } },
    { type: 'separator' as const },
    { label: pending > 0 ? `更新中心（${pending} 项可更新）` : '更新中心', click: () => goto('updates') },
    { label: '插件管理', click: () => goto('plugins') },
    { label: '多模态', click: () => goto('vision') },
    { label: '桥接接口', click: () => goto('bridge') },
    { label: '日志', click: () => goto('logs') },
    { type: 'separator' as const },
    {
      label: '重启后端',
      enabled: s.phase !== 'starting' && s.phase !== 'restarting',
      click: () => { void restart() },
    },
    { type: 'separator' as const },
    { label: '退出 Krill', role: 'quit' as const },
  ])

  tray.setContextMenu(menu)
  tray.setToolTip(`Krill —— 后端${PHASE_LABEL[s.phase]}`)
  // 角标只在有事时出现；平时保持安静
  tray.setTitle(pending > 0 ? ` ${pending}` : '')
}

export function createTray(): void {
  if (tray !== null) return
  const img = nativeImage.createFromPath(iconPath())
  img.setTemplateImage(true)
  tray = new Tray(img)
  tray.on('click', () => { createWindow(); focusWindow() })
  refreshTray()
}

/** 更新中心检查完后调用，让托盘角标跟上。 */
export function setUpdateReport(r: UpdateReport): void {
  lastReport = r
  refreshTray()
}
