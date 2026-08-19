/**
 * 主进程入口：生命周期、单实例、装配、IPC 收口。
 */
import { app, ipcMain, shell, BrowserWindow, nativeImage } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { log, openLog, closeLog, tail, onLine, logDir } from './backend/log-ring.ts'
import * as backend from './backend/supervisor.ts'
import {
  createWindow, attachApp, detachApp, setAppBounds, setAppVisible,
  reloadApp, focusWindow, getShellContents, getWindow, captureViews,
} from './window/shell-window.ts'
import { createTray, refreshTray, setUpdateReport } from './window/tray.ts'
import * as updates from './update/index.ts'
import * as plugins from './plugins/index.ts'
import * as bridge from './bridge/server.ts'
import { loadConfig, saveConfig } from './config/store.ts'
import type { AppInfo, OpResult, Rect } from '@shared/ipc'

const SMOKE = process.argv.includes('--smoke-test')
/** --capture=<前缀>：把两个 view 各抓一张 PNG 后退出（开发期验证渲染用） */
const CAPTURE = process.argv.find((a) => a.startsWith('--capture='))?.slice('--capture='.length) ?? null
/** --dev-bridge：本次运行强制启用桥接接口（开发期验证用，不改配置文件） */
const DEV_BRIDGE = process.argv.includes('--dev-bridge')
/** --dev-uninstall=<包名>：跑一次真实卸载流程后退出（开发期验证四处清理用） */
const DEV_UNINSTALL = process.argv.find((a) => a.startsWith('--dev-uninstall='))?.slice('--dev-uninstall='.length) ?? null
/** --panel=<id>：抓图前先切到指定面板，用来验证某个面板的渲染 */
const PANEL = process.argv.find((a) => a.startsWith('--panel='))?.slice('--panel='.length) ?? null
/** --capture-delay=<毫秒>：抓图前等多久，等异步数据（如更新检查）落地 */
const CAPTURE_DELAY = Number(process.argv.find((a) => a.startsWith('--capture-delay='))?.slice('--capture-delay='.length) ?? '3000')

// ─── 单实例 ──────────────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { createWindow(); focusWindow() })
  void main()
}

function ok<T>(value: T): OpResult<T> { return { ok: true, value } }
function fail(error: string, detail?: string): OpResult<never> {
  return detail === undefined ? { ok: false, error } : { ok: false, error, detail }
}

/** 把可能抛的操作统一收成 OpResult，渲染层永远不用 try/catch。 */
async function guard<T>(fn: () => Promise<T> | T): Promise<OpResult<T>> {
  try { return ok(await fn()) } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

function registerIpc(): void {
  ipcMain.handle('app:info', (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    logDir: logDir(),
    userData: app.getPath('userData'),
  }))
  ipcMain.handle('app:openLogDir', () => guard(async () => { await shell.openPath(logDir()) }))
  ipcMain.handle('app:openExternal', (_e, url: string) => guard(async () => {
    // 只放行 http(s)：渲染层传进来的字符串不该有能力打开本地文件或自定义协议
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`拒绝打开非 http(s) 链接：${u.protocol}`)
    await shell.openExternal(url)
  }))

  ipcMain.handle('view:setBounds', (_e, rect: Rect) => { setAppBounds(rect) })
  ipcMain.handle('view:setVisible', (_e, visible: boolean) => { setAppVisible(visible) })
  ipcMain.handle('view:reload', () => { reloadApp() })

  ipcMain.handle('backend:status', () => backend.getStatus())
  ipcMain.handle('backend:restart', () => guard(async () => {
    const url = await backend.restart()
    attachApp(url)
  }))
  ipcMain.handle('backend:stop', () => guard(() => { backend.stop(); detachApp() }))

  ipcMain.handle('log:tail', (_e, limit: number) => tail(limit))

  ipcMain.handle('update:state', () => updates.getReport())
  ipcMain.handle('update:check', () => guard(() => updates.checkAll({ force: true, reason: '面板手动' })))
  ipcMain.handle('update:upgradeCli', () => guard(() => updates.upgradeCli()))
  ipcMain.handle('update:pullSourceRepo', () => guard(() => updates.pullSourceRepo()))
  ipcMain.handle('update:appDownload', () => guard(() => updates.downloadApp()))
  ipcMain.handle('update:appInstall', () => guard(() => updates.installApp()))

  ipcMain.handle('plugins:state', () => plugins.getState())
  ipcMain.handle('plugins:refresh', () => guard(() => plugins.refresh()))
  ipcMain.handle('plugins:install', (_e, a: { spec: string; channel: 'injected' | 'official' }) =>
    guard(() => plugins.install(a)))
  ipcMain.handle('plugins:uninstall', (_e, a: { name: string }) => guard(() => plugins.uninstall(a)))
  ipcMain.handle('plugins:setDisabled', (_e, a: { name: string; disabled: boolean }) =>
    guard(() => plugins.setDisabled(a)))
  ipcMain.handle('plugins:patchDoctor', (_e, a: { fix: boolean }) => guard(() => plugins.patchDoctor(a)))

  ipcMain.handle('bridge:status', () => bridge.status())
  ipcMain.handle('bridge:config', () => loadConfig().bridge)
  ipcMain.handle('bridge:setConfig', (_e, patch: Partial<import('@shared/ipc').BridgeConfig>) =>
    guard(async () => {
      const next = saveConfig({ bridge: { ...loadConfig().bridge, ...patch } })
      await bridge.reconcile()
      return next.bridge
    }))
  ipcMain.handle('bridge:rotateToken', () => guard(() => bridge.rotateToken()))
}

/**
 * 开发模式下把 Dock 图标换成我们自己的。
 *
 * 打包后 Dock 读的是 .app 里的 icon.icns，没问题；但 `electron .` 直接跑时，
 * Dock 显示的是 Electron 二进制自带的原子图标 —— 开发期看着像另一个 App。
 * macOS 允许运行时覆盖，这里补上，让开发态和打包态看起来一致。
 */
function applyDockIcon(): void {
  if (process.platform !== 'darwin' || app.isPackaged) return
  const iconPath = join(app.getAppPath(), 'build', 'icon.png')
  if (!existsSync(iconPath)) {
    log(`跳过 Dock 图标：找不到 ${iconPath}（先跑 npm run icons）`)
    return
  }
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) {
    log(`跳过 Dock 图标：${iconPath} 解码失败`, 'stderr')
    return
  }
  app.dock?.setIcon(image)
  log('已设置开发态 Dock 图标')
}

async function main(): Promise<void> {
  await app.whenReady()
  openLog()
  log(`=== Krill v${app.getVersion()} 启动（${process.platform}/${process.arch}）===`)

  applyDockIcon()

  const cfg = loadConfig()
  log(`配置：更新间隔 ${cfg.updateIntervalHours}h，桥接接口 ${cfg.bridge.enabled ? '已启用' : '已关闭'}`)

  registerIpc()
  createWindow()
  createTray()

  // 后端状态与日志实时推给外壳
  backend.onStatus((s) => {
    getShellContents()?.send('backend:changed', s)
    refreshTray()
  })
  onLine((line) => { getShellContents()?.send('log:line', line) })

  updates.onChange((r) => {
    getShellContents()?.send('update:changed', r)
    setUpdateReport(r)
  })
  updates.start()

  plugins.onChange((s) => { getShellContents()?.send('plugins:changed', s) })
  bridge.onChange(() => { getShellContents()?.send('bridge:changed', bridge.status()) })
  // 配置里开着才起 —— 默认关闭，这个接口能在本机执行任务
  if (cfg.bridge.enabled || DEV_BRIDGE) {
    if (DEV_BRIDGE && !cfg.bridge.enabled) saveConfig({ bridge: { ...cfg.bridge, enabled: true } })
    void bridge.start().then((s) => {
      log(`DEV_BRIDGE_READY port=${String(s.port)} token=${s.token}`)
    }).catch((e: unknown) => {
      log(`桥接接口自动启动失败：${e instanceof Error ? e.message : String(e)}`, 'stderr')
    })
  }
  // 后端就绪后才有注入器可探；每次后端状态变 ready 都重新收一次清单
  backend.onStatus((st) => { if (st.phase === 'ready') void plugins.refresh() })

  try {
    const url = await backend.start()
    log(`后端就绪：${url}`)
    attachApp(url)
    if (SMOKE) {
      log('SMOKE_TEST_PASS：后端就绪且窗口已装配')
      setTimeout(() => app.quit(), 2_000)
    }
    if (DEV_UNINSTALL !== null) {
      setTimeout(() => {
        void plugins.uninstall({ name: DEV_UNINSTALL })
          .then((msg) => { log(`DEV_UNINSTALL 结果：\n${msg}`) })
          .catch((e: unknown) => { log(`DEV_UNINSTALL 失败：${String(e)}`, 'stderr') })
          .finally(() => { setTimeout(() => app.quit(), 1_000) })
      }, 3_000)
    }
    if (CAPTURE !== null) {
      if (PANEL !== null) getShellContents()?.send('nav:goto', { panel: PANEL })
      // 抓图模式下立刻跑一轮，不等 20s 定时器 —— 等太久显示器会休眠，
      // 届时 capturePage 会报 "Current display surface not available for capture"
      void updates.checkAll({ reason: '抓图模式预热' })
      // 等一帧渲染完再抓，否则可能抓到还没上色的空白
      setTimeout(() => {
        void captureViews(CAPTURE).then((files) => {
          for (const f of files) log(`已抓图：${f}`)
          app.quit()
        }).catch((e: unknown) => {
          log(`抓图失败：${String(e)}`, 'stderr')
          app.quit()
        })
      }, Number.isFinite(CAPTURE_DELAY) ? CAPTURE_DELAY : 3_000)
    }
  } catch (e) {
    // 起不来也要留着窗口 —— 外壳会显示失败原因与日志，比一个错误弹窗有用得多
    log(`后端启动失败：${e instanceof Error ? e.message : String(e)}`, 'stderr')
    if (SMOKE) {
      log('SMOKE_TEST_FAIL：后端未能就绪', 'stderr')
      setTimeout(() => app.exit(1), 1_000)
    }
  }

  app.on('activate', () => {
    if (getWindow() === null && BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      const s = backend.getStatus()
      if (s.url !== null) attachApp(s.url)
    }
    focusWindow()
  })
}

app.on('before-quit', () => {
  backend.markQuitting()
  backend.stop()
  bridge.stop()
})

// macOS：关窗不退出，后端继续在后台跑、会话不断，点 Dock 图标秒开。
// 其它平台沿用惯例：窗口全关即退出。
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  updates.stop()
  closeLog()
})

process.on('uncaughtException', (err) => {
  log(`主进程未捕获异常：${err.stack ?? err.message}`, 'stderr')
})
