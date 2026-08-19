import { useEffect, useState } from 'react'
import type { PluginsState, PluginEntry } from '@shared/ipc'

const CHANNEL_LABEL: Record<PluginEntry['channel'], string> = {
  official: '官方装配',
  injected: '热注入',
  both: '两通道并存',
  none: '未装配',
}

export function PluginsPanel(): React.JSX.Element {
  const [s, setS] = useState<PluginsState | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.dsh['plugins:state']().then(setS)
    const off = window.dsh.on('plugins:changed', setS)
    void window.dsh['plugins:refresh']()
    return off
  }, [])

  if (s === null) return <div className="panel"><div className="empty">加载中…</div></div>

  const health = s.patchHealth
  const patchSick = health.parseError !== null
    || health.duplicateIds.length > 0
    || health.orphanDisabled.length > 0

  return (
    <div className="panel">
      <h1 className="panel-head">插件</h1>
      <p className="panel-sub">
        合并 profile 依赖、层叠成员与注入器运行时状态
        {s.injectorAvailable ? '' : ' · 注入器不可用，热更新通道关闭'}
      </p>

      <div className="toolbar">
        <button className="btn" disabled={busy} onClick={() => {
          setBusy(true); void window.dsh['plugins:refresh']().finally(() => setBusy(false))
        }}>{busy ? '刷新中…' : '刷新'}</button>
        <span className="spacer" />
        <span className={`tag${s.injectorAvailable ? ' tag-ok' : ''}`}>
          热更新通道 {s.injectorAvailable ? '可用' : '不可用'}
        </span>
      </div>

      {s.restartRequired ? (
        <div className="note note-warn">
          有条目已标记卸载或禁用，<b>重启后端后才真正生效</b> —— 卸载走「标记 + 重启」，
          不做热卸载（热卸载会留僵尸工具、孤儿路由与永久累积的 disabled 条目）。
        </div>
      ) : null}

      {/* ── patch 体检 ─────────────────────────────────────────── */}
      <div className="card">
        <div className="row">
          <div>
            <div className="card-title">cordis.patch.yml 体检</div>
            <div className="muted mono">{health.path || '—'}</div>
          </div>
          <span className={`tag${patchSick ? ' tag-bad' : ' tag-ok'}`}>
            {patchSick ? '有问题' : '健康'}
          </span>
        </div>
        {health.parseError !== null ? (
          <div className="err-line">解析失败：{health.parseError}</div>
        ) : null}
        {health.duplicateIds.length > 0 ? (
          <div className="err-line">
            重复的 loader entry id：{health.duplicateIds.join('、')}
            {'\n'}dsh 装配遇到重复 id 会直接抛 duplicate loader entry id —— <b>启动即崩</b>。
          </div>
        ) : null}
        {health.orphanDisabled.length > 0 ? (
          <div className="muted hint">
            {health.orphanDisabled.length} 个 disabled 条目指向已不存在的包：
            {health.orphanDisabled.join('、')} —— 属于卸载残留，可清理。
          </div>
        ) : null}
        {!patchSick ? (
          <div className="muted hint">无重复 id，无孤儿 disabled 条目。</div>
        ) : null}
      </div>

      {/* ── 清单 ───────────────────────────────────────────────── */}
      <div className="card">
        <div className="row">
          <div>
            <div className="card-title">已装插件</div>
            <div className="muted">共 {s.entries.length} 项</div>
          </div>
        </div>
        {s.entries.length === 0 ? (
          <div className="muted hint">没有读到任何插件。</div>
        ) : (
          <table className="tbl tbl-plugins">
            <tbody>
              {s.entries.map((e) => (
                <tr key={`${e.profile}/${e.name}`}>
                  <td>
                    <div className="mono">{e.name}</div>
                    {e.description !== null ? (
                      <div className="muted desc">{e.description}</div>
                    ) : null}
                    <div className="chips">
                      {e.isBundle ? <span className="tag tag-dim">层叠</span> : null}
                      {e.hasClient ? (
                        <span className={`tag ${e.clientBundleMissing ? 'tag-bad' : 'tag-dim'}`}>
                          {e.clientBundleMissing ? 'client 未构建' : 'client UI'}
                        </span>
                      ) : null}
                      {e.disabled ? <span className="tag tag-bad">已禁用</span> : null}
                      {e.pendingRemoval ? <span className="tag tag-bad">待卸载</span> : null}
                    </div>
                  </td>
                  <td className="muted">{e.profile}</td>
                  <td className="mono">{e.version ?? '—'}</td>
                  <td>
                    <span className={`tag${e.channel === 'both' ? ' tag-bad' : ''}`}>
                      {CHANNEL_LABEL[e.channel]}
                    </span>
                  </td>
                  <td>
                    {e.active === true ? <span className="dot dot-ok" title="fiber 活跃" />
                      : e.active === false ? <span className="dot dot-bad" title="fiber 未活跃" />
                        : <span className="muted" title="注入器未报告该包的运行时状态">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {s.entries.some((e) => e.channel === 'both') ? (
          <div className="err-line">
            有包同时处于两条通道。两条通道对同一个包<b>互斥</b> ——
            会造出重复 loader entry id，dsh 启动即崩。请只保留一条。
          </div>
        ) : null}
        {s.entries.some((e) => e.clientBundleMissing) ? (
          <div className="muted hint">
            标「client 未构建」的包声明了浏览器半边却缺 <span className="mono">lib/client.js</span>，
            装上也不会有 UI —— 需要在该包目录里跑一次 client 构建。
          </div>
        ) : null}
      </div>

      <div className="card">
        <div className="card-title">安装 / 卸载</div>
        <div className="muted hint">
          安装与卸载动作属于 P3 后半段，尚未接线。设计已定：
          安装默认走热注入（免重启），需要固化时转官方装配；
          卸载与禁用一律「标记 + 重启」，并清理四处残留
          （profile 依赖与 bundles、注入器 registry.json、patch 条目、node_modules 链接）。
        </div>
      </div>
    </div>
  )
}
