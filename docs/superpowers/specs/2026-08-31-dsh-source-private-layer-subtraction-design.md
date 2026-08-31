# dsh-source 私有层减法：把已被上游吸收的补丁删掉，并压平成单提交

日期：2026-08-31
状态：已批准，待实施
仓库：`~/deepseek-harness/dsh-source`（上游 `deepseek-ai/deepseek-harness`）
关联：`~/my/dsh`（桌面端，`packs/dsh-vision-pack`、`scripts/gen-mod-patches.mjs`）

## 背景

桌面端"更新"面板每次拉取源码仓库都失败。`src/main/update/source-repo.ts` 的 `pull()`
跑的是 `git rebase --autostash --no-fork-point origin/master`，而 `master` 上叠着 4 个
未推上游的私有提交。上游从 0.1.1-rc.2 到 0.1.2-alpha.2 走了 234 个提交，其中 10 个
动过我们打补丁的文件，所以 rebase 必然冲突。

rebase 逐个重放，最老那个提交（`5487bf0918`）的补丁文本是照着 0.1.1-rc.2 写的；
队尾的适配提交（`edb351b7ef`）帮不上前面的忙。于是每次升级都要在古代基线上把
同一个冲突解四遍。

## 决定性发现

上游 0.1.2-alpha.2 已经原生实现了"文本模型下把图片投影成占位文本"：

- `packages/llm/llm/src/content.ts` 新增 `projectImagesForTextModel()` 与 `textOnlyImageText()`
- `packages/llm/llm/src/index.ts:996-1001` 在 `LlmRuntime` 派发前自动应用，
  条件是 `modelInfo.inputModalities` 存在且不含 `image`

占位文本为 `[image omitted because this model accepts text only; attachment sha256:xxxxxxxx]`，
自带 attachmentId 前缀，比我们的 `[图片 #n]` 更适合寻址。

这使我们 4 个语义补丁中的 3 个变成冗余。

## 目标

把私有层从「4 个语义补丁 + 15 个改动文件 + 4 个提交」缩到
「1 个语义补丁 + 7 处清单登记 + 1 个提交」。

桌面端 `packs/dsh-vision-pack/package.json` 的 `krill.corePatches` 随之从 4 项降到 1 项，
上游发版后不必再重做三份产物补丁。

## 范围

### 删除（上游已原生吸收）

| 文件 | 删什么 | 上游对应物 |
|---|---|---|
| `packages/llm/llm/src/content.ts` | `IMAGE_PLACEHOLDER`、`placeholderImages()` | `textOnlyImageText()`、`projectImagesForTextModel()` |
| `packages/llm/llm-deepseek/src/serialize.ts` | `flattenUserText()` 及 `assertTextOnly` 的角色拆分，恢复上游版 | `LlmRuntime` 派发前已投影，user 分支见不到 image 块 |
| `packages/llm/llm-pi-ai/src/adapter.ts` | `textOnlyModel` 分支，恢复上游版 | 同上 |
| `packages/llm/llm-deepseek/tests/serialize.spec.ts` | 全部回退到上游版 | — |
| `packages/llm/llm-pi-ai/tests/adapter.spec.ts` | 全部回退到上游版 | — |

### 修改（跟上游占位符换文案）

`packages/context/vision/src/index.ts`：

- 去掉 `import { IMAGE_PLACEHOLDER } from '@deepseek-ai/dsh-llm'` 与
  `export { IMAGE_PLACEHOLDER }`、`export { placeholderImages } from '@deepseek-ai/dsh-llm'`
- 模块头注释、system prompt（`tool:vision_inspect` 那条）、`vision_inspect` 的
  `description`、以及越界错误信息里的 `[图片 #n]` 改成上游占位符的描述
- **寻址逻辑不动**：`vision_inspect` 按消息内 `imageIndex`（0 起）取 ref，
  不解析占位符文本，上游投影保持图片出现顺序，序号语义不变
- `packages/context/vision/package.json` 若因此不再需要 `@deepseek-ai/dsh-llm`
  的值导出，仍保留类型依赖

### 移出仓库（改为未跟踪本地文件）

- `packages/bundle/base/cordis.patch.yml` 的 `vision` 行
- `packages/bundle/web-app/cordis.patch.yml` 的 `ui-vision`、`ui-live2d` 行

搬到一份本地 profile patch，路径写进 `.git/info/exclude`，永不参与 rebase。
依据：`cordis.patch.yml` 文件头注释——"the user's profile cordis.patch.yml
address these rows by id, with the last write winning per row"。
先例：`~/my/dsh/packs/dsh-vision-pack/cordis.patch.yml` 已经是这个用法。

### 保留（不可避免的低冲突单行登记）

- `packages/api/session-controller/src/commands.ts`（5 行）——图片闸门 +
  `import type {} from '@deepseek-ai/dsh-vision'` 副作用类型导入。本轮唯一语义补丁
- `packages/api/session-controller/package.json`（+2 依赖行）
- `packages/api/session-controller/tsconfig.host.json`（+1 reference）
- `tsconfig.host.json`（+1）、`tsconfig.client.json`（+2）
- `packages/bundle/base/package.json`（+1）、`packages/bundle/web-app/package.json`（+2）
- `THIRD_PARTY_NOTICES.md`（+2，live2d 依赖声明）

### 保留原样、不纳入本轮

- 未跟踪的 `packages/client/tsdown.url-shim.ts`（live2d 的 pixi `url` 垫片 WIP，
  目前没有任何文件引用它，`tsdown.client.ts` 的接线尚未做）。它未被跟踪，
  `rebase --abort` 与后续操作都不会动它。

## 执行路径

不在当前这次半截 rebase 里边打边删——旧基线上还没有 `projectImagesForTextModel`，
在那里做取舍等于猜测。改为在 `origin/master` 上重建私有层：

1. `git branch krill-backup-2026-08-31 master` 留退路（已有的
   `krill-backup-before-cleanup` 保持不动）
2. `git rebase --abort` 收拾现场，回到 `master`
3. 从 `origin/master` 开新分支 `private-layer`
4. 把私有整包原样取过来：`packages/context/vision`、`packages/client/ui-vision`、
   `packages/client/ui-live2d`、`apps/web/public/live2d/**`
5. 手工加回「保留」清单里的 7 处登记 + `commands.ts` 的 5 行闸门
6. 按「修改」清单调整 `packages/context/vision/src/index.ts`
7. lockfile：`git checkout HEAD -- pnpm-lock.yaml` 后
   `pnpm install --lockfile-only --registry https://registry.npmmirror.com`
   （npmjs 走本机代理会超时）
8. 清理上游删包留下的 `lib/`、`node_modules/` 幽灵目录（tsdown 会扫到并报
   MISSING_EXPORT）
9. 落成**一个**提交，把 `master` 指过去

## 验证

- `npm run typecheck`（host 构建 + client tsc）通过
- `packages/context/vision/tests/vision.spec.ts` 通过
- `packages/llm/llm-deepseek`、`packages/llm/llm-pi-ai`、`packages/llm/llm` 三个包的
  测试与上游一致且全绿——现存的 WIP 失败用例应随减法消失。若仍有失败，
  说明减法删多了或上游投影的行为与假设不符，需回到设计重审
- `git diff origin/master..master --stat` 应只剩「保留」清单里的 8 个文件加 `pnpm-lock.yaml`
- 桌面端重跑 `node scripts/gen-mod-patches.mjs`，确认 `krill.corePatches`
  只剩 `@deepseek-ai/dsh-host-apiproxy` 一项
- 桌面端"更新"面板重新检查，`ahead 1 / behind 0`

## 本轮不做

`commands.ts` 图片闸门的结构化。设想的方向：让 vision 插件在 `resolveModel`
层为文本路由声明 `inputModalities` 含 `image`，从而闸门自然放行、彻底不碰上游源码。
但那样会关掉上游的自动投影，需要 vision 插件自己承接投影，属于新的语义设计，
留到下一轮单独 brainstorm。

## 风险

- **上游投影只在 `inputModalities` 有值时触发。** 若某供应商的 `resolveModel`
  不返回 `inputModalities`，图片块会原样进入 adapter。这与减法前的行为差异需在
  验证阶段确认（`llm-pi-ai` 的 `model.input` 与 `inputModalities` 的映射关系）
- **占位符文案变更影响模型行为。** `vision_inspect` 的调用时机依赖 prompt 里
  描述的占位符样式，改文案后需实测模型仍会在看到 `[image omitted …]` 时调用工具
