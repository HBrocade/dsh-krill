import { useEffect, useRef, useState } from 'react'
import type { LogLine, LogLevel } from '@shared/ipc'

const FILTERS: Array<{ id: LogLevel | 'all'; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'app', label: '应用' },
  { id: 'stdout', label: '后端输出' },
  { id: 'stderr', label: '后端错误' },
]

export function LogsPanel(): React.JSX.Element {
  const [lines, setLines] = useState<LogLine[]>([])
  const [filter, setFilter] = useState<LogLevel | 'all'>('all')
  const [follow, setFollow] = useState(true)
  const viewRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void window.dsh['log:tail'](2000).then(setLines)
    // 增量订阅时按 seq 去重：面板挂载与首次 tail 之间可能漏进/重进几行
    return window.dsh.on('log:line', (line) => {
      setLines((prev) => (prev.length > 0 && prev[prev.length - 1]!.seq >= line.seq
        ? prev
        : [...prev.slice(-1999), line]))
    })
  }, [])

  useEffect(() => {
    if (!follow) return
    const el = viewRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [lines, follow])

  const shown = filter === 'all' ? lines : lines.filter((l) => l.level === filter)

  return (
    <div className="panel">
      <h1 className="panel-head">日志</h1>
      <p className="panel-sub">
        应用日志与后端 stdout/stderr 实时合流。内存保留最近 2000 行；完整历史落在日志目录。
      </p>

      <div className="toolbar">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={`btn${filter === f.id ? ' btn-primary' : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
        <span className="spacer" />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-dim)' }}>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          自动滚动
        </label>
        <button className="btn" onClick={() => { void window.dsh['app:openLogDir']() }}>
          打开日志目录
        </button>
      </div>

      <div className="log-view" ref={viewRef} onWheel={() => setFollow(false)}>
        {shown.length === 0
          ? <div className="empty">暂无日志</div>
          : shown.map((l) => (
              <div className="log-line" key={l.seq}>
                <span className="log-ts">{new Date(l.ts).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                <span className={`log-${l.level}`}>{l.text}</span>
              </div>
            ))}
      </div>
    </div>
  )
}
