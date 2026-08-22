/**
 * 识图配置卡片。
 *
 * 存在的理由是一条报错：`404 model 'qwen3.8:27b-mtp-q8_0' not found`。
 * 配错模型时，正确答案（本机装了哪些、哪些真能识图）只有 Ollama 知道 ——
 * 让人对着报错去手改 YAML，等于要他自己猜一个字符串。
 *
 * 所以这里只做一件事：把可选项列出来，并把「为什么现在不能用」说清楚。
 */
import { useCallback, useEffect, useState } from 'react'
import type { OpResult, VisionState } from '@shared/ipc'

export function VisionCard(): React.JSX.Element | null {
  const [st, setSt] = useState<VisionState | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const load = useCallback(() => {
    void window.dsh['vision:state']().then(setSt)
  }, [])
  useEffect(load, [load])

  if (st === null) return null

  const save = (patch: Partial<VisionState['config']>): void => {
    setBusy(true); setNote(null)
    void window.dsh['vision:setConfig']({ ...st.config, ...patch })
      .then((res: OpResult<VisionState>) => {
        setBusy(false)
        if (res.ok) {
          setSt(res.value)
          setNote({ kind: 'ok', text: '已保存，重启后端后生效' })
        } else {
          setNote({ kind: 'err', text: res.error })
        }
      })
  }

  const visionModels = st.models.filter((m) => m.vision)

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">识图</div>
          <div className="muted card-sub">
            给文本模型配一个能看图的本地模型：图片在请求里换成 <code>[图片 #n]</code>，
            模型需要时再用 <code>vision_inspect</code> 回头看那张图。
          </div>
        </div>
        <label className="vision-toggle">
          <input
            type="checkbox"
            checked={st.config.enabled}
            disabled={busy}
            onChange={(e) => { save({ enabled: e.target.checked }) }}
          />
          <span>{st.config.enabled ? '已启用' : '已停用'}</span>
        </label>
      </div>

      {!st.ollamaRunning ? (
        <div className="err-line">
          连不上本机 Ollama（127.0.0.1:11434）。启动它之后回来这里选模型。
        </div>
      ) : (
        <>
          <label className="vision-row">
            <span>模型</span>
            <select
              value={st.config.model}
              disabled={busy}
              onChange={(e) => { save({ model: e.target.value }) }}
            >
              {/* 配着一个本机没有的模型时，把它自己也列出来并标明 ——
                  否则下拉框会显示成空的，用户不知道当前配的是什么 */}
              {st.modelMissing ? (
                <option value={st.config.model}>{st.config.model}（本机没有）</option>
              ) : null}
              {st.config.model === '' ? <option value="">（未选择）</option> : null}
              {visionModels.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
            </select>
          </label>

          {st.modelMissing ? (
            <div className="err-line">
              当前配的 <code>{st.config.model}</code> 在本机 Ollama 里不存在 —— 请求会以
              <code>404 model not found</code> 失败。从上面重选一个。
            </div>
          ) : null}
          {st.modelNotVision ? (
            <div className="err-line">
              <code>{st.config.model}</code> 不支持图片输入（Ollama 上报的能力里没有 vision）。
            </div>
          ) : null}

          <div className="muted hint">
            本机 {st.models.length} 个模型里 {visionModels.length} 个能识图。
            下拉里只列能识图的 —— 其余选了也用不了。
          </div>
        </>
      )}

      {note !== null ? (
        <div className={note.kind === 'ok' ? 'ok-line' : 'err-line'}>{note.text}</div>
      ) : null}
    </div>
  )
}
