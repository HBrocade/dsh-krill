import { useState } from 'react'
import type { BackendStatus } from '@shared/ipc'
import brandUrl from '../assets/brand.png'

export type PanelId = 'chat' | 'plugins' | 'updates' | 'vision' | 'bridge' | 'logs'

const ITEMS: Array<{ id: PanelId; label: string; icon: React.JSX.Element }> = [
  { id: 'chat',    label: '会话',    icon: <IconChat /> },
  { id: 'plugins', label: '插件',    icon: <IconPlug /> },
  { id: 'updates', label: '更新',    icon: <IconUp /> },
  { id: 'vision',  label: '多模态',  icon: <IconEye /> },
  { id: 'bridge',  label: '桥接',    icon: <IconBridge /> },
  { id: 'logs',    label: '日志',    icon: <IconLog /> },
]

const PHASE_TEXT: Record<BackendStatus['phase'], string> = {
  idle: '未启动', locating: '定位 dsh…', starting: '启动中…',
  ready: '运行中', restarting: '重启中…', crashed: '已崩溃', failed: '启动失败',
}

function dotClass(phase: BackendStatus['phase'] | undefined): string {
  if (phase === 'ready') return 'status-dot ready'
  if (phase === 'starting' || phase === 'locating' || phase === 'restarting') return 'status-dot busy'
  if (phase === 'crashed' || phase === 'failed') return 'status-dot bad'
  return 'status-dot'
}

export function Sidebar(props: {
  active: PanelId
  onSelect: (id: PanelId) => void
  backend: BackendStatus | null
}): React.JSX.Element {
  const { active, onSelect, backend } = props
  // 默认收成轨道：dsh SPA 自带宽侧栏，两条并排太占地方。选择记在本地。
  const [rail, setRail] = useState(() => localStorage.getItem('sidebar.rail') !== '0')
  const toggle = (): void => {
    setRail((v) => {
      localStorage.setItem('sidebar.rail', v ? '0' : '1')
      return !v
    })
  }
  return (
    <nav className={`sidebar${rail ? ' rail' : ''}`}>
      <div className="brand">
        <BrandMark />
        <span className="brand-text">Krill</span>
      </div>
      <div className="nav">
        {ITEMS.map((it) => (
          <button
            key={it.id}
            className={`nav-item${active === it.id ? ' active' : ''}`}
            onClick={() => onSelect(it.id)}
            title={rail ? it.label : undefined}
          >
            <span className="nav-icon">{it.icon}</span>
            <span>{it.label}</span>
          </button>
        ))}
      </div>
      <div className="sidebar-foot">
        <button className="rail-toggle" onClick={toggle} title={rail ? '展开侧栏' : '收起侧栏'}>
          <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor"
               strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            {rail
              ? <path d="M4 10h11M11 6l4 4-4 4" />
              : <path d="M16 10H5M9 6l-4 4 4 4" />}
          </svg>
          <span>收起侧栏</span>
        </button>
        <div className="status" title={`${backend?.message ?? ''}${backend?.port != null ? ` :${backend.port}` : ''}`.trim() || undefined}>
          <span className={dotClass(backend?.phase)} />
          <span>
            {backend === null ? '连接中…' : PHASE_TEXT[backend.phase]}
            {backend?.port != null ? `  :${backend.port}` : ''}
          </span>
        </div>
        {backend?.dshVersion != null ? (
          <div className="status status-ver" style={{ marginTop: 5 }}>
            <span style={{ width: 7 }} />
            <span>dsh {backend.dshVersion}</span>
          </div>
        ) : null}
      </div>
    </nav>
  )
}

/** 侧栏品牌标：应用图标里那只黑色大肥鱼，透明底小图。 */
function BrandMark(): React.JSX.Element {
  return <img className="brand-mark" src={brandUrl} alt="" draggable={false} />
}

const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
function IconChat() { return <svg viewBox="0 0 20 20" {...S}><path d="M4 4h12v9H8l-4 3z" /></svg> }
function IconPlug() { return <svg viewBox="0 0 20 20" {...S}><path d="M7 3v4M13 3v4M5 7h10v3a5 5 0 01-10 0zM10 15v3" /></svg> }
function IconUp()   { return <svg viewBox="0 0 20 20" {...S}><path d="M10 16V5M6 9l4-4 4 4M4 17h12" /></svg> }
function IconEye()  { return <svg viewBox="0 0 20 20" {...S}><path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z" /><circle cx="10" cy="10" r="2.2" /></svg> }
function IconBridge(){ return <svg viewBox="0 0 20 20" {...S}><path d="M3 13V9M17 13V9M3 11h14M6 11V7M14 11V7M10 11V5" /></svg> }
function IconLog()  { return <svg viewBox="0 0 20 20" {...S}><path d="M4 4h12v12H4zM7 8h6M7 11h6M7 14h3" /></svg> }
