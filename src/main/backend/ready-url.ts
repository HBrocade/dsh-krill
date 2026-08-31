/**
 * 后端就绪行的解析与就绪状态码判定。
 *
 * 单独成模块是为了能测：`supervisor.ts` 传递依赖 electron，测试脚本 import
 * 不动，而这两个判定恰恰是「窗口空白」那类事故的根因所在，必须有回归守卫。
 *
 * @module main/backend/ready-url
 */

/** 只认回环地址；URL 允许出现的字符里不含空白与成对引号、尖括号。 */
const READY_URL = /https?:\/\/127\.0\.0\.1:\d+[^\s"'<>]*/
/** 日志里 URL 后面常跟中英文标点，它们不属于 URL。 */
const TRAILING_PUNCT = /[.,;:!?)\]}。，、；：！？）】]+$/

/**
 * 从后端 stdout 的一行里认出就绪 URL。
 *
 * **必须连 query 一起截。** dsh 从 0.1.2-alpha.2 起给 web 加了 token 鉴权，
 * 打印的是 `http://127.0.0.1:PORT/?token=...`。只截 origin 的话，就绪探针
 * 请求到的是 401、窗口加载到的也是 401 页 —— 表现为日志停在 `dsh web:`
 * 那行、`后端就绪：` 永不出现、界面一直空白。旧版不打 token，截出来就是
 * 纯 origin，兼容。
 *
 * @param line - 后端 stdout 的一行。
 * @returns 完整就绪 URL（含 token query），认不出返回 null。
 */
export function parseReadyUrl(line: string): string | null {
  const m = READY_URL.exec(line)
  if (m === null) return null
  return m[0].replace(TRAILING_PUNCT, '')
}

/**
 * 就绪探测认不认这个 HTTP 状态码。
 *
 * 2xx 与 3xx 都算：带 token 的首个请求会回 303 跳转去种 cookie，而
 * `node:http` 不跟随跳转，硬卡 200 会永远探不到就绪。401 **不算** ——
 * 那说明 token 没带对，应该让它超时把问题报出来，而不是装作已经好了。
 *
 * @param code - 响应状态码，连接失败时为 undefined。
 * @returns 是否视为后端已就绪。
 */
export function isReadyStatus(code: number | undefined): boolean {
  return code !== undefined && code >= 200 && code < 400
}
