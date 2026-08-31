import { parseReadyUrl, isReadyStatus } from '../src/main/backend/ready-url.ts'

// 真实数据：dsh 0.1.2-alpha.2 与 0.1.1-rc.2 各自打印的就绪行
const withToken = '[stdout] dsh web: http://127.0.0.1:62322/?token=SMjR8lHSEDs4oGt-44hzy3xx2BHSN8oYB8ia0Vl6jVY'
const legacy = 'dsh web: http://127.0.0.1:58775'

const cases: Array<[string, unknown, unknown]> = [
  ['带 token 的行：整条 URL 都要，token 不能丢',
    parseReadyUrl(withToken),
    'http://127.0.0.1:62322/?token=SMjR8lHSEDs4oGt-44hzy3xx2BHSN8oYB8ia0Vl6jVY'],
  ['旧版不打 token：截出纯 origin，兼容',
    parseReadyUrl(legacy),
    'http://127.0.0.1:58775'],
  ['认不出的行返回 null',
    parseReadyUrl('桥接接口已启动：仅回环，免鉴权'),
    null],
  ['只认回环，不认别的主机',
    parseReadyUrl('serving on http://10.0.0.5:8080/?token=abc'),
    null],
  ['URL 后跟中文标点时不把标点吞进来',
    parseReadyUrl('后端在 http://127.0.0.1:62322/?token=abc 上。'),
    'http://127.0.0.1:62322/?token=abc'],
  ['截出来的 URL 能被 new URL 解析出端口',
    new URL(parseReadyUrl(withToken) ?? '').port,
    '62322'],

  // probe() 的判定：带 token 的首个请求回 303 去种 cookie，node:http 不跟随跳转
  ['200 算就绪', isReadyStatus(200), true],
  ['303 算就绪（token 握手的跳转）', isReadyStatus(303), true],
  ['401 不算就绪 —— token 没带对就该超时报出来，不能装作好了', isReadyStatus(401), false],
  ['404 不算就绪', isReadyStatus(404), false],
  ['500 不算就绪', isReadyStatus(500), false],
  ['没有状态码不算就绪', isReadyStatus(undefined), false],
]
let bad = 0
for (const [name, got, want] of cases) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(got)}`))
}
console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`)
process.exit(bad === 0 ? 0 : 1)
