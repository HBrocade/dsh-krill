import { useEffect, useState } from 'react'
import type { BridgeStatus, BridgeConfig, OpResult } from '@shared/ipc'

export function BridgePanel(): React.JSX.Element {
  const [st, setSt] = useState<BridgeStatus | null>(null)
  const [cfg, setCfg] = useState<BridgeConfig | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [showToken, setShowToken] = useState(false)
  const [roots, setRoots] = useState('')

  useEffect(() => {
    void window.dsh['bridge:status']().then(setSt)
    void window.dsh['bridge:config']().then((c) => { setCfg(c); setRoots(c.allowedRoots.join('\n')) })
    return window.dsh.on('bridge:changed', setSt)
  }, [])

  const patch = async (p: Partial<BridgeConfig>, key: string): Promise<void> => {
    setBusy(key); setNote(null)
    const res: OpResult<BridgeConfig> = await window.dsh['bridge:setConfig'](p)
    setBusy(null)
    if (res.ok) {
      setCfg(res.value)
      void window.dsh['bridge:status']().then(setSt)
      setNote({ kind: 'ok', text: '已保存' })
    } else {
      setNote({ kind: 'err', text: res.error })
    }
  }

  const copy = (text: string, what: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => setNote({ kind: 'ok', text: `${what}已复制到剪贴板` }),
      () => setNote({ kind: 'err', text: '复制失败' }),
    )
  }

  if (st === null || cfg === null) return <div className="panel"><div className="empty">加载中…</div></div>

  return (
    <div className="panel">
      <h1 className="panel-head">桥接接口</h1>
      <p className="panel-sub">
        让 Claude Code 等外部工具把 dsh 当作第二意见来源 —— 另一个模型、另一个角度看同一份改动
      </p>

      {note !== null ? <div className={`note note-${note.kind}`}>{note.text}</div> : null}

      {/* ── 开关与状态 ────────────────────────────────────────── */}
      <div className="card">
        <div className="row">
          <div>
            <div className="card-title">服务状态</div>
            <div className="muted">
              {st.running
                ? `运行中 · http://127.0.0.1:${String(st.port)} · 已服务 ${String(st.totalServed)} 次 · 进行中 ${String(st.inflight)}`
                : '未启动'}
            </div>
            <div className="muted" style={{ marginTop: 4 }}>
              使用模型 <span className="mono">{st.model}</span> —— 与你聊天用的是同一份全局配置，调用方无需指定
            </div>
          </div>
          <button
            className={`btn${cfg.enabled ? '' : ' btn-primary'}`}
            disabled={busy !== null}
            onClick={() => { void patch({ enabled: !cfg.enabled }, 'toggle') }}
          >
            {busy === 'toggle' ? '处理中…' : cfg.enabled ? '关闭接口' : '启用接口'}
          </button>
        </div>
        <div className="muted hint">
          <b>默认关闭</b>。这个接口能在本机执行任务，所以只绑 <span className="mono">127.0.0.1</span>、
          强制 Bearer token、工作目录需通过校验、并发有上限。不会监听外部地址。
        </div>
        {st.lastError !== null ? <div className="err-line">{st.lastError}</div> : null}
      </div>

      {/* ── 接入 Claude Code ──────────────────────────────────── */}
      <div className="card">
        <div className="card-title">接入 Claude Code</div>
        {!st.running ? (
          <div className="muted hint">启用接口后这里会给出可直接复制的接入命令。</div>
        ) : (
          <>
            {/* 命令里含 token —— 默认掩码。否则「隐藏 token」形同虚设，
                截图或投屏时会连命令一起把 token 泄出去。复制走的仍是原文。 */}
            <pre className="code-block">
              {showToken ? st.mcpCommand : st.mcpCommand.replace(st.token, '•'.repeat(24))}
            </pre>
            <div className="toolbar" style={{ marginTop: 10, marginBottom: 0 }}>
              <button className="btn" onClick={() => copy(st.mcpCommand, '接入命令')}>复制命令</button>
              <button className="btn" onClick={() => setShowToken((v) => !v)}>
                {showToken ? '隐藏 token' : '显示 token'}
              </button>
              <span className="spacer" />
              <span className="muted">
                装好后 Claude Code 会多出 <span className="mono">dsh_ask</span> 与{' '}
                <span className="mono">dsh_review</span> 两个工具
              </span>
            </div>
            <div className="muted hint">
              命令里的 <span className="mono">&lt;Krill.app&gt;</span> 需替换成实际安装路径；
              开发模式下 shim 在项目的{' '}
              <span className="mono">resources/bridge-mcp/index.mjs</span>。
            </div>
          </>
        )}
      </div>

      {/* ── token ─────────────────────────────────────────────── */}
      <div className="card">
        <div className="row">
          <div>
            <div className="card-title">访问 token</div>
            <div className="mono token">{showToken ? st.token : '•'.repeat(32)}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => setShowToken((v) => !v)}>
              {showToken ? '隐藏' : '显示'}
            </button>
            <button className="btn" onClick={() => copy(st.token, 'token')}>复制</button>
            <button className="btn btn-danger" disabled={busy !== null} onClick={() => {
              setBusy('rot')
              void window.dsh['bridge:rotateToken']().then((r) => {
                setBusy(null)
                setNote(r.ok
                  ? { kind: 'ok', text: 'token 已轮换 —— 已接入的客户端需要更新配置' }
                  : { kind: 'err', text: r.error })
                void window.dsh['bridge:status']().then(setSt)
              })
            }}>{busy === 'rot' ? '轮换中…' : '轮换'}</button>
          </div>
        </div>
      </div>

      {/* ── 配置 ──────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-title">配置</div>
        <div className="cfg-grid">
          <label>监听端口</label>
          <div>
            <input className="input mono" type="number" value={cfg.port}
              onChange={(e) => setCfg({ ...cfg, port: Number(e.target.value) })}
              onBlur={() => { void patch({ port: cfg.port }, 'port') }} />
            <span className="muted"> 0 = 由系统分配</span>
          </div>

          <label>超时（毫秒）</label>
          <div>
            <input className="input mono" type="number" value={cfg.timeoutMs}
              onChange={(e) => setCfg({ ...cfg, timeoutMs: Number(e.target.value) })}
              onBlur={() => { void patch({ timeoutMs: cfg.timeoutMs }, 'timeout') }} />
          </div>

          <label>并发上限</label>
          <div>
            <input className="input mono" type="number" value={cfg.maxConcurrent}
              onChange={(e) => setCfg({ ...cfg, maxConcurrent: Number(e.target.value) })}
              onBlur={() => { void patch({ maxConcurrent: cfg.maxConcurrent }, 'conc') }} />
          </div>

          <label>工作目录白名单</label>
          <div>
            <textarea className="input mono" rows={3} value={roots}
              placeholder="每行一个绝对路径；留空表示不限根目录（仍要求目录真实存在）"
              onChange={(e) => setRoots(e.target.value)}
              onBlur={() => {
                void patch({ allowedRoots: roots.split('\n').map((s) => s.trim()).filter((s) => s !== '') }, 'roots')
              }} />
          </div>
        </div>
        <div className="muted hint">
          改端口后接口会重启，已接入的客户端要更新地址。
        </div>
      </div>

      {/* ── 端点 ──────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-title">端点</div>
        <table className="tbl">
          <tbody>
            <tr>
              <td className="mono">GET /v1/docs</td>
              <td className="muted">自描述文档：当前模型、参数、示例、限制。调用方读一次就知道怎么用</td>
            </tr>
            <tr>
              <td className="mono">POST /v1/ask</td>
              <td className="muted">{'{prompt, cwd?}'} —— 干活的那个</td>
            </tr>
          </tbody>
        </table>
        <div className="muted hint">
          刻意只有两个。模型、凭据、profile 都不暴露给调用方 —— 它们取自 <span className="mono">~/.dsh</span>
          全局配置，和你聊天用的是同一份。代码审查这类便利封装放在 MCP shim 侧本地组装，不往服务端加端点。
          <br />
          任务本身失败（非零退出）返回 HTTP 200 带 <span className="mono">exitCode</span> ——
          调用方要能拿到输出自己判断，而不是只收到一个错误码。
        </div>
      </div>
    </div>
  )
}
