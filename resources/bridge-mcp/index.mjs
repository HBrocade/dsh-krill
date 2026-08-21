#!/usr/bin/env node
/**
 * Krill 桥接的 stdio MCP shim。
 *
 * 让 Claude Code 之类的 MCP 客户端把 dsh 当作第二意见来源：
 * 本文件只做协议转换，真正的执行在 Krill 的桥接 HTTP 服务里。
 *
 * 接入（不需要填端口和 token）：
 *   claude mcp add dsh -- node <本文件绝对路径>
 *
 * 端口和 token 是**每次调用时现读**的，不是注册时写死的 —— 桥接绑的是随机端口，
 * 焊进 `--env` 的注册在 App 下次重启后就失效，而失效的表现是「连不上／超时」，
 * 注册当天还好好的，第二天才开始出问题，极难自查。
 *
 * 刻意不引任何依赖 —— 它要能在用户机器上被裸 node 直接跑起来。
 */
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Krill 写下的发现文件的默认位置，可用 KRILL_BRIDGE_FILE 覆盖。 */
function discoveryFile() {
  if (process.env.KRILL_BRIDGE_FILE) return process.env.KRILL_BRIDGE_FILE
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Krill', 'bridge.json')
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Krill', 'bridge.json')
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Krill', 'bridge.json')
}

/**
 * 解析出这次要连的地址与 token。
 *
 * 环境变量优先（方便开发时指到别处），否则读发现文件。**每次调用都重读** ——
 * Krill 重启换了端口、或者轮换了 token，这里都能立刻跟上，不用重新注册。
 */
function resolveTarget() {
  const envBridge = process.env.KRILL_BRIDGE
  const envToken = process.env.KRILL_TOKEN
  if (envBridge && envToken) return { endpoint: envBridge, token: envToken }

  const f = discoveryFile()
  let raw
  try {
    raw = readFileSync(f, 'utf8')
  } catch {
    throw new Error(
      `找不到桥接的发现文件 ${f} —— Krill 没在运行，或者「桥接」面板里没启用。`
      + '启用后无需重新注册 MCP，这里会自动读到新的端口与 token。',
    )
  }
  let parsed
  try { parsed = JSON.parse(raw) } catch { throw new Error(`发现文件不是合法 JSON：${f}`) }
  if (!parsed.endpoint || !parsed.token) throw new Error(`发现文件缺 endpoint 或 token：${f}`)
  return { endpoint: parsed.endpoint, token: parsed.token }
}
const PROTOCOL_VERSION = '2025-06-18'

const TOOLS = [
  {
    name: 'dsh_ask',
    description:
      '把一个问题交给 DeepSeek Harness（dsh）跑一次一次性任务，返回它的回答。'
      + '用于获取来自另一个模型的独立意见。任务在本机执行，可指定工作目录。'
      + '模型与凭据取自用户的 dsh 全局配置，与其聊天时所用的完全一致，无需也无法指定。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '要交给 dsh 的任务或问题' },
        cwd: { type: 'string', description: '工作目录绝对路径；省略则用主目录' },
        timeoutMs: { type: 'number', description: '超时毫秒数，省略用桥接配置的默认值' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'dsh_review',
    description:
      '让 dsh 以独立审查者的身份看一份代码改动，给出第二意见。'
      + '可以直接传 diff 文本，也可以只给工作目录和 git ref 让它自己去取。',
    inputSchema: {
      type: 'object',
      properties: {
        diff: { type: 'string', description: 'diff 文本；给了就直接审查它' },
        cwd: { type: 'string', description: '仓库目录绝对路径' },
        ref: { type: 'string', description: 'git ref，缺省 HEAD；仅在没传 diff 时使用' },
        focus: { type: 'string', description: '希望重点关注的方面' },
      },
    },
  },
]

/**
 * 把 review 请求在**本地**组装成一句 prompt。
 *
 * 桥接的 HTTP 面刻意只有两个端点（一个文档、一个执行），
 * review 这类便利封装放在客户端这边，不往服务端加端点。
 */
function buildReviewPrompt({ diff, ref, focus }) {
  const parts = [
    '你是一位独立的代码审查者，正在为另一个 AI 的工作提供第二意见。',
    '只报告你有把握的问题，给出具体位置与可复现的失败场景；',
    '没把握的猜测请明确标注为猜测。不要复述改动做了什么。',
    '',
  ]
  if (focus && focus.trim()) parts.push(`重点关注：${focus.trim()}`, '')
  if (diff && diff.trim()) {
    parts.push('待审查的 diff：', '```diff', diff.trim(), '```')
  } else {
    const r = (ref && ref.trim()) || 'HEAD'
    parts.push(
      `请先在当前工作目录运行 \`git diff ${r}\`（若无输出则试 \`git diff ${r}~1 ${r}\`）`,
      '拿到改动内容，然后审查它。',
    )
  }
  return parts.join('\n')
}

async function callBridge(path, body) {
  // 每次调用重新解析 —— Krill 重启换了端口或轮换了 token，这里立刻跟上
  const { endpoint, token } = resolveTarget()
  const res = await fetch(`${endpoint}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { throw new Error(`桥接返回的不是 JSON：${text.slice(0, 300)}`) }
  if (!res.ok) throw new Error(parsed.error ?? `桥接返回 HTTP ${res.status}`)
  return parsed
}

/** 把执行结果拍平成一段文本 —— 非零退出也要如实说明，不能装作成功。 */
function renderResult(r) {
  const lines = []
  if (r.text) lines.push(r.text)
  if (r.timedOut) lines.push('\n[任务超时被中止，以上是超时前的输出]')
  else if (r.exitCode !== 0) {
    lines.push(`\n[dsh 以退出码 ${r.exitCode} 结束]`)
    if (r.stderrTail) lines.push(`[stderr 尾部]\n${r.stderrTail}`)
  }
  if (lines.length === 0) lines.push('[dsh 没有产生任何输出]')
  return lines.join('\n')
}

const send = (msg) => { process.stdout.write(`${JSON.stringify(msg)}\n`) }
const reply = (id, result) => { send({ jsonrpc: '2.0', id, result }) }
const fail = (id, message) => { send({ jsonrpc: '2.0', id, error: { code: -32000, message } }) }

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const { id, method, params } = msg

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'krill-dsh-bridge', version: '0.1.0' },
    })
    return
  }
  if (method === 'notifications/initialized') return
  if (method === 'tools/list') { reply(id, { tools: TOOLS }); return }

  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments ?? {}
    let payload
    if (name === 'dsh_ask') {
      payload = { prompt: args.prompt, cwd: args.cwd, timeoutMs: args.timeoutMs }
    } else if (name === 'dsh_review') {
      payload = { prompt: buildReviewPrompt(args), cwd: args.cwd }
    } else {
      fail(id, `未知工具：${String(name)}`); return
    }
    callBridge('/v1/ask', payload)
      .then((r) => {
        reply(id, {
          content: [{ type: 'text', text: renderResult(r) }],
          isError: r.exitCode !== 0 || r.timedOut === true,
        })
      })
      .catch((e) => { fail(id, e instanceof Error ? e.message : String(e)) })
    return
  }

  if (id !== undefined) fail(id, `未实现的方法：${String(method)}`)
})
