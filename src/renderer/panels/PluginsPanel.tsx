import { useEffect, useState } from 'react'
import type { PluginsState, PluginEntry, InstallOutcome, OpResult, RecognitionStep } from '@shared/ipc'

const CHANNEL_LABEL: Record<PluginEntry['channel'], string> = {
  official: '官方装配',
  injected: '热注入',
  both: '两通道并存',
  none: '未装配',
}

export function PluginsPanel(): React.JSX.Element {
  const [s, setS] = useState<PluginsState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [spec, setSpec] = useState('')
  const [channel, setChannel] = useState<'injected' | 'official'>('injected')
  const [note, setNote] = useState<{ kind: 'ok' | 'err' | 'warn'; text: string } | null>(null)
  const [steps, setSteps] = useState<RecognitionStep[] | null>(null)

  const act = async (
    key: string,
    fn: () => Promise<OpResult<unknown>>,
    ok: (v: unknown) => string,
  ): Promise<void> => {
    setBusy(key); setNote(null); setSteps(null)
    const res = await fn()
    setBusy(null)
    setNote(res.ok ? { kind: 'ok', text: ok(res.value) } : { kind: 'err', text: res.error })
  }

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
        <button className="btn" disabled={busy !== null} onClick={() => {
          void act('refresh', () => window.dsh['plugins:refresh'](), () => '已刷新')
        }}>{busy === 'refresh' ? '刷新中…' : '刷新'}</button>
        <span className="spacer" />
        <span className={`tag${s.injectorAvailable ? ' tag-ok' : ''}`}>
          热更新通道 {s.injectorAvailable ? '可用' : '不可用'}
        </span>
      </div>

      {note !== null ? <div className={`note note-${note.kind === 'warn' ? 'warn' : note.kind}`}>{note.text}</div> : null}

      {s.restartRequired ? (
        <div className="note note-warn">
          有条目已标记卸载或禁用，<b>重启后端后才真正生效</b> —— 卸载走「标记 + 重启」，
          不做热卸载（热卸载会留僵尸工具、孤儿路由与永久累积的 disabled 条目）。
          <div style={{ marginTop: 10 }}>
            <button className="btn btn-primary" disabled={busy !== null} onClick={() => {
              void act('restart', () => window.dsh['backend:restart'](), () => '后端已重启')
            }}>{busy === 'restart' ? '重启中…' : '立即重启后端'}</button>
          </div>
        </div>
      ) : null}

      {/* ── patch 体检 ─────────────────────────────────────────── */}
      <div className="card">
        <div className="row">
          <div>
            <div className="card-title">cordis.patch.yml 体检</div>
            <div className="muted mono">{health.path || '—'}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {patchSick && health.parseError === null ? (
              <button className="btn" disabled={busy !== null} onClick={() => {
                void act('doctor', () => window.dsh['plugins:patchDoctor']({ fix: true }),
                  () => '已修复（原文件已备份）')
              }}>{busy === 'doctor' ? '修复中…' : '一键修复'}</button>
            ) : null}
            <span className={`tag${patchSick ? ' tag-bad' : ' tag-ok'}`}>
              {patchSick ? '有问题' : '健康'}
            </span>
          </div>
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
                  <td className="acts">
                    <button className="btn btn-sm" disabled={busy !== null || e.pendingRemoval}
                      title={e.disabled ? '启用（重启后生效）' : '禁用（重启后生效）'}
                      onClick={() => {
                        void act(`dis:${e.name}`,
                          () => window.dsh['plugins:setDisabled']({ name: e.name, disabled: !e.disabled }),
                          (v) => String(v))
                      }}>{e.disabled ? '启用' : '禁用'}</button>
                    <button className="btn btn-sm btn-danger" disabled={busy !== null || e.pendingRemoval}
                      title="清理四处残留并标记卸载，重启后生效"
                      onClick={() => {
                        void act(`rm:${e.name}`,
                          () => window.dsh['plugins:uninstall']({ name: e.name }),
                          (v) => String(v))
                      }}>{e.pendingRemoval ? '待重启' : '卸载'}</button>
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
        <div className="card-title">安装插件</div>
        <div className="install-row">
          <input
            className="input mono"
            placeholder="本地目录 / .tgz 路径 / https 的 .tgz 链接"
            value={spec}
            onChange={(ev) => setSpec(ev.target.value)}
          />
          <select className="input select" value={channel}
            onChange={(ev) => setChannel(ev.target.value as 'injected' | 'official')}>
            <option value="injected">热注入（免重启）</option>
            <option value="official">官方装配（需重启）</option>
          </select>
          <button className="btn btn-primary"
            disabled={busy !== null || spec.trim() === '' || (channel === 'injected' && !s.injectorAvailable)}
            onClick={() => {
              setBusy('install'); setNote(null); setSteps(null)
              void window.dsh['plugins:install']({ spec: spec.trim(), channel }).then((res) => {
                setBusy(null)
                if (!res.ok) { setNote({ kind: 'err', text: res.error }); return }
                const o = res.value as InstallOutcome
                setSteps(o.steps)
                setNote(o.recognized
                  ? { kind: 'ok', text: `${o.name ?? '插件'} 安装完成，识别闭环全部通过` }
                  : { kind: 'warn', text: `${o.name ?? '插件'} 已装入，但识别闭环有步骤未通过 —— 见下方逐步结果` })
              })
            }}>{busy === 'install' ? '安装中…' : '安装'}</button>
        </div>
        <div className="muted hint">
          默认走<b>热注入</b>：免重启、当场生效，清单持久化、重启自动恢复。
          需要长期固化时选官方装配。
          <b>两条通道对同一个包互斥</b> —— 同时存在会造出重复 loader entry id，dsh 启动即崩，
          所以安装前会先核对。
          {s.injectorAvailable ? '' : '当前注入器不可用，只能走官方装配。'}
        </div>
      </div>

      {steps !== null ? (
        <div className="card">
          <div className="card-title">识别闭环</div>
          <div className="muted hint" style={{ marginTop: 0, marginBottom: 10 }}>
            文件落盘不等于 dsh 认到了。逐步验，卡在哪一步就报哪一步。
          </div>
          {steps.map((st) => (
            <div className="step" key={st.step}>
              <span className={`step-mark ${st.skipped ? 'skip' : st.ok ? 'ok' : 'bad'}`}>
                {st.skipped ? '—' : st.ok ? '✓' : '✗'}
              </span>
              <div>
                <div>{st.label}{st.skipped ? <span className="muted">（跳过）</span> : null}</div>
                {st.detail !== null ? <div className="muted desc">{st.detail}</div> : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
