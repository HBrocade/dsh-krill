/**
 * 窗口装配：BaseWindow + 两个 WebContentsView。
 *
 *   shellView —— 我们自己的 React 外壳（侧栏、各管理面板），铺满整窗，在下层
 *   appView   —— 官方 dsh SPA，按外壳上报的内容区矩形定位，在上层
 *
 * 为什么不用 iframe 装 SPA：WebContentsView 有独立渲染进程，SPA 崩了不会带走
 * 我们的外壳；`setWindowOpenHandler`、缩放、devtools 也能按 view 单独接线。
 * 代价是布局要靠 IPC 同步矩形 —— 值得。
 */
import { BaseWindow, WebContentsView, shell, screen } from 'electron'
import { join } from 'node:path'
import { log } from '../backend/log-ring.ts'
import type { Rect } from '@shared/ipc'

let win: BaseWindow | null = null
let shellView: WebContentsView | null = null
let appView: WebContentsView | null = null
let appUrl: string | null = null
let appVisible = true
let lastRect: Rect = { x: 0, y: 0, width: 0, height: 0 }

const MIN_WIDTH = 1000
const MIN_HEIGHT = 640

export function getWindow(): BaseWindow | null { return win }
export function getShellContents(): Electron.WebContents | null { return shellView?.webContents ?? null }

/** 外部链接一律交给系统浏览器；站内跳转放行。 */
function fenceNavigation(view: WebContentsView, isInside: (url: string) => boolean): void {
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (isInside(url)) return { action: 'allow' }
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  view.webContents.on('will-navigate', (event, url) => {
    if (isInside(url)) return
    event.preventDefault()
    void shell.openExternal(url)
  })
}

export function createWindow(): BaseWindow {
  if (win !== null && !win.isDestroyed()) return win

  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  win = new BaseWindow({
    width: Math.min(1440, Math.max(MIN_WIDTH, sw - 160)),
    height: Math.min(920, Math.max(MIN_HEIGHT, sh - 120)),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: 'Krill',
    backgroundColor: '#0B0E15',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // 红绿灯必须完整落在左侧轨道内，且两侧留够呼吸。
    // 实测三个按钮横跨约 55px（系统绘制，尺寸不受我们控制）。
    // 轨道 88px、x=16 → 占 16..71，左 16 右 17，视觉居中。
    // 曾经用过 72px 轨道 + x=8：右侧只剩 5px，紧贴 SPA 边界，很挤。
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 18 } : undefined,
  })

  shellView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload 需要 require('electron')；能力仍由 ipc.ts 白名单收口
    },
  })
  shellView.setBackgroundColor('#0B0E15')
  win.contentView.addChildView(shellView)

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl !== undefined && devUrl !== '') {
    void shellView.webContents.loadURL(devUrl)
  } else {
    void shellView.webContents.loadFile(join(__dirname, '../renderer/index.html'))
  }
  fenceNavigation(shellView, (url) => url.startsWith('devtools://')
    || (devUrl !== undefined && url.startsWith(devUrl))
    || url.startsWith('file://'))

  const layout = (): void => {
    if (win === null || win.isDestroyed() || shellView === null) return
    const b = win.contentView.getBounds()
    shellView.setBounds({ x: 0, y: 0, width: b.width, height: b.height })
    applyAppBounds()
  }
  win.on('resize', layout)
  layout()

  win.on('closed', () => {
    win = null
    shellView = null
    appView = null
  })

  return win
}

/** 把 dsh SPA 挂到窗口上（后端就绪后调用）。重复调用会切到新地址。 */
export function attachApp(url: string): void {
  if (win === null || win.isDestroyed()) return
  appUrl = url
  if (appView === null) {
    appView = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true, // 官方 SPA 不需要任何 Node 能力，关死
      },
    })
    appView.setBackgroundColor('#0B0E15')
    win.contentView.addChildView(appView)
    fenceNavigation(appView, (u) => appUrl !== null && u.startsWith(appUrl))
    appView.webContents.on('render-process-gone', (_e, details) => {
      log(`dsh 页面渲染进程异常退出：${JSON.stringify(details)}`, 'stderr')
    })
  }
  void appView.webContents.loadURL(url)
  applyAppBounds()
}

/** 后端停了就把 SPA 摘掉，别让用户对着一张已经失效的页面点。 */
export function detachApp(): void {
  if (appView === null || win === null || win.isDestroyed()) return
  win.contentView.removeChildView(appView)
  appView.webContents.close()
  appView = null
  appUrl = null
}

function applyAppBounds(): void {
  if (appView === null) return
  if (!appVisible) {
    // 移出可视区而不是销毁：面板关掉时能立刻回来，SPA 不用重新加载、会话不断
    appView.setBounds({ x: -20000, y: 0, width: Math.max(1, lastRect.width), height: Math.max(1, lastRect.height) })
    return
  }
  appView.setBounds({
    x: Math.round(lastRect.x),
    y: Math.round(lastRect.y),
    width: Math.max(1, Math.round(lastRect.width)),
    height: Math.max(1, Math.round(lastRect.height)),
  })
}

/** 渲染层上报内容区矩形（外壳布局变化时调用）。 */
export function setAppBounds(rect: Rect): void {
  lastRect = rect
  applyAppBounds()
}

export function setAppVisible(visible: boolean): void {
  appVisible = visible
  applyAppBounds()
}

export function reloadApp(): void {
  if (appView !== null && appUrl !== null) void appView.webContents.loadURL(appUrl)
}

export function focusWindow(): void {
  if (win === null || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.focus()
}

/**
 * 把两个 view 各自抓成 PNG。
 * 用 webContents.capturePage 而不是系统截屏：不需要屏幕录制权限，
 * 无头/CI 环境同样能出图 —— 这是验证「界面真的渲染出来了」的可靠手段。
 */
export async function captureViews(prefix: string): Promise<string[]> {
  const { writeFile } = await import('node:fs/promises')
  const out: string[] = []
  if (shellView !== null) {
    const img = await shellView.webContents.capturePage()
    const p = `${prefix}-shell.png`
    await writeFile(p, img.toPNG())
    out.push(p)
  }
  if (appView !== null) {
    const img = await appView.webContents.capturePage()
    const p = `${prefix}-app.png`
    await writeFile(p, img.toPNG())
    out.push(p)
  }
  return out
}
