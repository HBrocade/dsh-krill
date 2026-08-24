<div align="center">

<img src="build/icon.png" width="112" alt="Krill">

# Krill

**[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的非官方 macOS 桌面端**

官方 Web 前端做主界面，外面套一层原生管理层

</div>

> [!IMPORTANT]
> **这不是 DeepSeek 官方项目**，与 DeepSeek 无隶属关系。官方只提供 `dsh web`（浏览器 + 常驻终端）。
> 本项目是个人自用的桌面外壳，自行承担使用风险。

---

## 这是什么

DeepSeek Harness（`dsh`）官方形态是 `dsh web` —— 起一个本地 HTTP 服务，用浏览器访问，
终端得一直挂着。Krill 把这只 Node 服务变成**隐藏的后台子进程**代为管理，双击即用。

但仅仅"不用挂终端"是不够的。Krill 在官方 Web 界面之外补了一层原生能力：

| 面板 | 干什么 |
|---|---|
| **会话** | 官方 dsh React SPA，零改动嵌入 |
| **插件** | 查询 / 安装 / 卸载 / 升级 / 启停 |
| **供应商** | 用穿梭框决定每条路线最终服务哪些模型：补上目录漏掉的，去掉不想要的 |
| **更新** | dsh CLI、已装插件、桌面 App 自身、源码仓库，四类更新检测 |
| **桥接** | 本地 HTTP 接口（固定端口，免鉴权），让别的工具把 dsh 当第二意见来源 |
| **日志** | 应用日志与后端 stdout/stderr 实时合流 |

## 架构

```
┌─ 托盘 ────────────────────────────────────────────────┐
│ ● 后端运行中 :51823   ⬆ dsh rc.6 → rc.7               │
├───────────────────────────────────────────────────────┤
│ ┌────┬────────────────────────────────────────────┐   │
│ │ 会 │                                            │   │
│ │ 插 │   WebContentsView                          │   │
│ │ 供 │   http://127.0.0.1:<自动端口>               │   │
│ │ 更 │   官方 dsh React SPA（零改动）              │   │
│ │ 桥 │                                            │   │
│ │ 日 │                                            │   │
│ │    │                                            │   │
│ └────┴────────────────────────────────────────────┘   │
│   ↑ 外壳的 React 渲染层（BaseWindow 的底层 view）      │
└───────────────────────────────────────────────────────┘
      主进程：supervisor / update / plugins / catalog / bridge
              │ spawn（隐藏）            │ HTTP :bridgePort
        dsh web（npm 内嵌）        外部调用方（Claude Code）
```

`BaseWindow` + 两个 `WebContentsView`：外壳在下层铺满整窗，官方 SPA 在上层按外壳上报的
矩形定位。**不用 iframe** —— WebContentsView 有独立渲染进程，SPA 崩了不会带走外壳，
导航拦截与缩放也能按 view 单独接线。

会话、凭据、模型配置仍然存放在 `~/.dsh`，与浏览器版**共用同一份数据**。
后端只绑 `127.0.0.1`，不暴露到网络。

## 开发

```bash
npm install
npm run embed     # 把 @deepseek-ai/dsh 装进 resources/dsh（约 312MB）
npm run icons     # 从 build/whale.png 生成 icns / 托盘图 / 品牌标
npm run pack-mod <mod 目录>   # 把一个 mod 打成可分发的 .tgz（带校验）
npm run dev       # 启动
```

前提：本机已初始化过 `~/.dsh/profiles/web`（即 `dsh web` 能正常跑起来）。

```bash
npm run typecheck  # 主进程 + 渲染层分别 tsc
npm run smoke      # 构建后启动，后端就绪即退出
npm run pack       # 只出未压缩的 .app（快，验证结构用）
npm run dist       # 出 dmg + zip（arm64）
```

开发期调试用的开关：

| 参数 | 作用 |
|---|---|
| `--smoke-test` | 后端就绪即退出，退出码表示成败 |
| `--capture=<前缀>` | 把两个 view 各抓一张 PNG 后退出。用 `capturePage` 而非系统截屏，**不需要屏幕录制权限**，无头环境也能出图 |

## 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_BIN` | 指定 dsh 入口，优先级高于 userData 升级副本与内嵌资源 |
| `DSH_NODE` | 指定 node 解释器；缺省用 PATH 中的 node，再无则用 Electron 自带 Node |

## 安全边界

| 项 | 措施 |
|---|---|
| 后端绑定 | 仅 `127.0.0.1` |
| 渲染进程 | `contextIsolation: true`、`nodeIntegration: false`；官方 SPA 那层额外 `sandbox: true` |
| IPC | preload 按 [`src/shared/ipc.ts`](src/shared/ipc.ts) 白名单逐个暴露，**不透传裸 `ipcRenderer.invoke`** |
| 导航 | 外部链接一律 `shell.openExternal`，且只放行 http(s) |
| 子进程 | 退出时 SIGTERM → 5s 宽限 → SIGKILL，防孤儿端口 |
| 凭据 | 不内嵌任何密钥，沿用 `~/.dsh` 凭据系统 |
| 桥接接口 | **默认关闭**；启用后仅绑回环、拒绝一切带 `Origin` 的请求（挡住本机网页）、POST 强制 JSON。Bearer token 可选（`bridge.requireToken`），默认不要 —— 本机调用不必带票 |

## 完成度

- [x] **P0** 工程脚手架（electron-vite + TypeScript strict + React）
- [x] **P1** 外壳骨架：后端 supervisor、双 view 窗口、托盘、日志面板
- [x] **P2** 更新中心：dsh CLI / 插件 / 源码仓库 / App 自身，四类检测
- [x] **P3** 插件管理器：清单合并、patch 体检、双通道安装、卸载四处清理、识别闭环
- [x] **P4** 桥接接口：两个端点（自描述文档 + 执行）+ stdio MCP shim

### 怎么调

固定在 `http://127.0.0.1:17801`，免鉴权，直接 curl：

```bash
curl -sX POST http://127.0.0.1:17801/v1/ask \
  -H 'content-type: application/json' \
  -d '{"prompt":"这段实现有什么隐患？","cwd":"/path/to/repo"}'
```

返回 `{ text, exitCode, durationMs, timedOut, stderrTail }`。任务失败不用 HTTP 错误码
表达 —— 一律 200，看 `exitCode` 与 `timedOut` 自己判断。

`GET /v1/docs` 是自描述文档，例子里直接写着真实地址，另一个 AI 读一遍就知道怎么调。

**安全边界**：这个端点等于在本机执行任意任务（dsh 会读文件、跑 bash、改代码）。
绑回环挡住了外网，挡不住本机的网页 —— 任何标签页都能往 `127.0.0.1` 发 POST，
响应读不到也无所谓，副作用已经发生。所以服务端拒绝一切带 `Origin` 头的请求
（浏览器必带、curl 必不带），并要求 POST 用 `application/json`（非简单类型，
浏览器得先过预检，而我们不发 CORS 头）。需要更强隔离就把 `bridge.requireToken` 打开。

MCP shim 仍然可用（`claude mcp add dsh -- node <Krill.app>/Contents/Resources/bridge-mcp/index.mjs`），
端口与 token 是调用时从 `<userData>/bridge.json` 现读的，不需要写进注册。
- [x] **P5** 改为插件承载 —— 多模态控制台不做成原生面板，由插件自己提供
- [x] **P6** 打包分发：dmg + zip（arm64），实测装入 /Applications 可启动

## 模型列表为什么会落后

「可选模型列表」不是 dsh 维护的，来自 `@earendil-works/pi-ai` 里一份**静态生成的
目录快照**（`dist/providers/data/<供应商>.json`）。dsh 把 pi-ai 钉在 `^0.82.1`，
而 `discovery.ts` 对目录内的供应商**不发任何网络请求** —— 点「拉取可用模型」
拿到的还是那份快照。于是供应商新上的模型，在选择器里怎么刷都刷不出来。

实测 opencode-go：线上 29 个，pi-ai 0.82.1 收 16 个、0.84.2 收 19 个。
两层都落后，光顶 pi-ai 的版本补不齐。

供应商面板绕过快照：向配了 key 的路线拉 `GET /models` 拿 id 清单，
元数据从 [models.dev](https://models.dev) 取，补不到的走兜底值。

**但清单不等于能用，所以每个目录外的模型都实测一发。** `GET /models` 列的是网关
知道的型号，不是你现在跑得通的型号 —— 实测 opencode-go 线上 29 个里就有：上游回
`Unsupported model` 的、preview 期 `Model is unavailable` 的、要去后台开通数据政策
（403 `DataPolicyError`）的，还有一个 `ox-alpha-free`：**不带工具能聊，一带工具就
503**。而 dsh 是 agent，每次调用都带工具定义，所以「能聊」在这里根本不算能用 ——
症状是聊到一半来一句 `Provider finish_reason: network_error`，那句话既不指向模型
也不指向工具，纯靠猜。

所以探测按 dsh 的真实用法（带工具）打一发，失败了再不带工具打一发，用来把
「不支持工具」和「压根不可用」分开 —— 这两句话在界面上是完全不同的意思。
结果缓存 6 小时（每发探测都要算进供应商限额），已经补进配置的也一并测，
坏掉的那个往往正是当初补进去的。

pi-ai 的目录本来就是筛过的（README 写着只收支持 tool calling 的模型），
我们从线上清单里补模型，就得自己把这道筛子补上。

**全程只写 `settings.yaml`，不碰 node_modules。** 改已装 pi-ai 的目录 JSON 看着更干净，
但内嵌的那棵树在 `.app/Contents/Resources` 里，签名后改了就坏签名，而且 dsh 一升级
就是 `npm install --prefix` 覆盖整棵树。配置文件两样都不沾。

穿梭框的两侧对应两种机制，别搞混：

**补目录外的模型 → 另开路线，原路线不动。**

而且是**按协议各开一条**，因为 `resolveRouteModels` 里一个 models 条目
**不带 api 字段**：目录里有的用目录记的协议，目录没有的退回「整条路线共用的协议」，
而共用协议只在路线上所有模型协议一致时才存在。opencode-go 恰好横跨
anthropic-messages / openai-completions / openai-responses 三种，于是新模型无处安放 ——
唯一能指定协议的是路线级 `api:`，它会盖掉路线上每一个模型。

**去掉目录自带的模型 → 只能动原路线。** dsh 没有黑名单，只有白名单：`models:` 一写就
**替换**整份目录，留下的就是清单里那些。好在清单里光写 `id` 不丢任何东西 —— 协议、容量、
价格、compat、思考档位全从目录条目继承（`...base` 展开），实测三种协议混排的 opencode-go
16 个砍到 13 个，一个字段都没变。

这里有两个坑，都踩过：

- `models: []` **不等于**「一个都不要」。schema 把缺省的 models 物化成 `[]`，
  所以空清单被读成「没写」，反而恢复整份目录。清空必须在写之前拦下来。
- 写了 `models:` 这条路线就**不再跟随目录更新** —— 以后 pi-ai 补的新模型不会自己冒出来，
  会出现在穿梭框左边等你挪。所以「一个都没去掉」时是把这个键**删掉**，而不是写一份全量清单。

协议靠 models.dev 记的 SDK 包名推，**不保证与官方目录一致**：拿 pi-ai 0.84.2
的 opencode-go 分组对过一遍，19 个里对 15 个（qwen3.7/3.8 系列和 minimax-m2.7
与 pi-ai 的选择相反 —— 网关多协议都收，pi-ai 是挑了个表现最好的，我们没有那个信息）。
所以做成穿梭框：右侧代表这条路线**最终**要有哪些模型（目录自带的和已经补进去的一开始
就都在右边），加和减是同一个动作，每行标着它是目录自带、已补、还是待补，恢复默认是一个按钮。

## 两个实现细节，供后来者避坑

**一、npm 的 `latest` dist-tag 在 dsh 家族上不可信。** `@deepseek-ai/dsh-base`、
`@deepseek-ai/dsh-web-app` 这些包的 `latest` 指向 `0.0.1-rc.1`，而实际最新是 `0.1.0-rc.7`。
（`@deepseek-ai/dsh` 本身的标签是对的，别被它误导。）任何版本检测都必须拉 `versions`
全量列表自己做 semver 排序 —— 用 `npm view <pkg> version` 会把升级报成降级。
见 [`src/shared/semver.ts`](src/shared/semver.ts) 与 [`tests/semver.check.ts`](tests/semver.check.ts)。

**二、源码仓库只报告，绝不自动 rebase。** 那个 checkout 里往往躺着未推上游的本地提交，
工作区还可能是脏的。旧版桌面端会后台静默 `git pull --rebase` —— 在实测环境里那意味着
把 4 个本地提交、带着未提交改动，rebase 到 111 个上游提交之上。Krill 只显示落后多少，
拉取是你自己点的按钮，冲突时中止并保留现场，**不代为解决**。

## 关于图标

那只黑色大肥鱼是 **[「蓝色大肥鱼」梗](https://www.gamersky.com/news/202608/2190273.shtml)的黑色版** ——
社区给 DeepSeek 鲸鱼吉祥物起的爱称。这是非官方外壳，所以不用官方那只蓝的。

制作过程：GPT Image 2 出概念稿 → 指定比例重绘（初版圆得像球，不像鲸）→
[`scripts/cutout.mjs`](scripts/cutout.mjs) 从画布边缘洪水填充抠图（不能用亮度阈值，
会把眼白和嘴线一起挖穿）→ [`scripts/gen-icons.mjs`](scripts/gen-icons.mjs) 合成全套。

## 许可

[MIT](LICENSE)

`dsh` 本身与其生态插件各自遵循各自的许可，与本项目无关。
