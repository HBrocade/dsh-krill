/**
 * 打包后钩子：把内嵌的 dsh 运行时复制进 .app。
 *
 * 为什么不用 electron-builder 的 extraResources：
 * resources/dsh 整个就是一棵 node_modules（311MB），实测 extraResources
 * 对它静默不生效 —— .app 里根本没有 dsh 目录，**而打包退出码仍然是 0**。
 * 加显式 filter 也没用。与其依赖一个会静默失败的机制，不如自己复制并校验。
 */
'use strict'
const { cpSync, existsSync, statSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  const { appOutDir, packager } = context
  const appName = packager.appInfo.productFilename
  const resources = join(appOutDir, `${appName}.app`, 'Contents', 'Resources')
  const src = join(context.packager.projectDir, 'resources', 'dsh')
  const dest = join(resources, 'dsh')

  if (!existsSync(src)) {
    throw new Error(
      `[after-pack] 找不到 ${src} —— 先跑 npm run embed 把 dsh 装进来，否则打出来的包没有后端`,
    )
  }

  cpSync(src, dest, { recursive: true, dereference: true })

  // 校验入口真的在：静默产出一个跑不起来的包是最坏的结果
  const entry = join(dest, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(entry)) {
    throw new Error(`[after-pack] 复制完成但 ${entry} 不存在，包是坏的`)
  }
  const mb = (n) => `${(n / 1024 / 1024).toFixed(0)}MB`
  let total = 0
  const walk = (p) => {
    const st = statSync(p)
    if (st.isDirectory()) {
      for (const e of require('node:fs').readdirSync(p)) walk(join(p, e))
    } else total += st.size
  }
  walk(dest)
  console.log(`  • 内嵌 dsh 已复制  ${mb(total)} → Contents/Resources/dsh`)
}
