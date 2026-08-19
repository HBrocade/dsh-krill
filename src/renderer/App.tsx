import { useCallback, useEffect, useRef, useState } from 'react'
import type { BackendStatus } from '@shared/ipc'
import { Sidebar, type PanelId } from './components/Sidebar.tsx'
import { LogsPanel } from './panels/LogsPanel.tsx'
import { UpdatesPanel } from './panels/UpdatesPanel.tsx'
import { PluginsPanel } from './panels/PluginsPanel.tsx'
import { BridgePanel } from './panels/BridgePanel.tsx'
import { Placeholder } from './panels/Placeholder.tsx'

export function App(): React.JSX.Element {
  const [panel, setPanel] = useState<PanelId>('chat')
  const [backend, setBackend] = useState<BackendStatus | null>(null)
  const slotRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void window.dsh['backend:status']().then(setBackend)
    const off = window.dsh.on('backend:changed', setBackend)
    const offNav = window.dsh.on('nav:goto', ({ panel: p }) => { setPanel(p as PanelId) })
    return () => { off(); offNav() }
  }, [])

  /**
   * 把 SPA 落位区的矩形上报给主进程。
   * 用 ResizeObserver 而不是监听 window.resize：侧栏折叠、面板切换这些
   * 不触发 window.resize 的布局变化同样要跟上，否则 SPA 会错位。
   */
  const report = useCallback(() => {
    const el = slotRef.current
    if (el === null) return
    const r = el.getBoundingClientRect()
    void window.dsh['view:setBounds']({ x: r.x, y: r.y, width: r.width, height: r.height })
  }, [])

  useEffect(() => {
    const el = slotRef.current
    if (el === null) return
    const ro = new ResizeObserver(report)
    ro.observe(el)
    report()
    return () => { ro.disconnect() }
  }, [report, panel])

  // 只有会话页显示 SPA；打开任何管理面板都把它移出可视区（不销毁，回来时秒回）
  useEffect(() => {
    void window.dsh['view:setVisible'](panel === 'chat')
  }, [panel])

  return (
    <div className="shell">
      <Sidebar active={panel} onSelect={setPanel} backend={backend} />
      <div className="main">
        {panel === 'chat' ? <div className="app-slot" ref={slotRef} /> : null}
        {panel === 'logs' ? <LogsPanel /> : null}
        {panel === 'updates' ? <UpdatesPanel /> : null}
        {panel === 'plugins' ? <PluginsPanel /> : null}
        {panel === 'bridge' ? <BridgePanel /> : null}
      </div>
    </div>
  )
}
