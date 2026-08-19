/**
 * 主进程 ↔ 渲染层的类型化 IPC 契约 —— 唯一真源。
 *
 * preload 按 `INVOKE_CHANNELS` / `EVENT_CHANNELS` 逐个白名单暴露，
 * **不透传裸 `ipcRenderer.invoke`**：渲染层跑的是我们自己的界面没错，
 * 但它同进程树里还挂着 dsh 的 SPA，透传等于把主进程能力敞开给整个页面。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 通用
// ─────────────────────────────────────────────────────────────────────────────

/** 一次可能失败的操作的统一结果。失败走 ok:false，不抛到渲染层。 */
export type OpResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: string; detail?: string }

export interface AppInfo {
  version: string
  platform: NodeJS.Platform
  arch: string
  /** 桌面端自身的日志目录，面板上「打开日志目录」用 */
  logDir: string
  userData: string
}

/** 渲染层上报的内容区矩形，主进程据此摆放承载 dsh SPA 的 WebContentsView。 */
export interface Rect { x: number; y: number; width: number; height: number }

// ─────────────────────────────────────────────────────────────────────────────
// 后端（dsh web 子进程）
// ─────────────────────────────────────────────────────────────────────────────

export type BackendPhase =
  | 'idle'        // 尚未启动
  | 'locating'    // 正在定位 dsh
  | 'starting'    // 已 spawn，等待就绪
  | 'ready'       // HTTP 200，可用
  | 'restarting'
  | 'crashed'     // 异常退出且已放弃自动重启
  | 'failed'      // 启动失败

export interface BackendStatus {
  phase: BackendPhase
  /** 就绪后的 http://127.0.0.1:<port>，未就绪为 null */
  url: string | null
  port: number | null
  /** 正在使用的 dsh 入口路径与版本，用于更新中心比对 */
  dshBin: string | null
  dshVersion: string | null
  /** 从哪来的：内嵌资源 / 环境变量 / PATH / 用户升级目录 */
  dshSource: 'embedded' | 'env' | 'path' | 'userdata' | null
  pid: number | null
  restarts: number
  /** 失败或崩溃时的说明，phase 正常时为 null */
  message: string | null
}

export type LogLevel = 'app' | 'stdout' | 'stderr'

export interface LogLine {
  /** 单调递增序号，渲染层据此去重与增量拉取 */
  seq: number
  ts: number
  level: LogLevel
  text: string
}

// ─────────────────────────────────────────────────────────────────────────────
// 更新中心
// ─────────────────────────────────────────────────────────────────────────────

export interface CliUpdate {
  current: string | null
  latest: string | null
  upgradable: boolean
  /** 检查失败时的原因（网络等），成功为 null */
  error: string | null
}

/**
 * 一个包的来源，决定它能不能、该不该独立升级：
 *   registry —— profile 依赖里从 npm 装的，可独立比对与升级
 *   local    —— file: / link: / git 来源，registry 上查不到
 *   runtime  —— 随 dsh 运行时自带（在 bundles 里但不在 dependencies），
 *               版本跟着 dsh 走，单独升级没有意义
 */
export type PluginSource = 'registry' | 'local' | 'runtime'

export interface PluginUpdate {
  name: string
  profile: string
  source: PluginSource
  current: string | null
  latest: string | null
  upgradable: boolean
  /** 是否在 dsh.profile.bundles 层叠里 */
  inBundles: boolean
  error: string | null
}

export interface SourceRepoUpdate {
  /** 本地仓库路径；不存在时 exists:false，其余字段无意义 */
  path: string
  exists: boolean
  branch: string | null
  behind: number
  ahead: number
  /** 有本地未推提交时为 true —— 决定了我们绝不自动 rebase */
  dirty: boolean
  error: string | null
}

export interface AppUpdate {
  /** 未配置发布渠道时 configured:false，面板显示「未配置」而非报错 */
  configured: boolean
  current: string
  latest: string | null
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'
  progressPercent: number | null
  error: string | null
}

export interface UpdateReport {
  checkedAt: number | null
  checking: boolean
  cli: CliUpdate
  plugins: PluginUpdate[]
  sourceRepo: SourceRepoUpdate
  app: AppUpdate
}

// ─────────────────────────────────────────────────────────────────────────────
// 插件
// ─────────────────────────────────────────────────────────────────────────────

/** 一个包当前所处的安装通道。两条通道对同一个包互斥 —— 同时存在会造重复 loader id。 */
export type PluginChannel = 'official' | 'injected' | 'both' | 'none'

/**
 * 一处代码级补丁的状态。
 *
 * 有些插件光靠挂载做不到，需要改宿主自己的代码（识图就是例子）。
 * 这类插件必须在面板上**显式标出来** —— 用户有权知道装一个插件会改动
 * 宿主的哪些包。
 */
export interface CorePatchInfo {
  package: string
  /** 作者针对哪个版本写的 —— 仅供展示与判断陈旧度，不是门禁 */
  authoredFor: string
  /** 作者声明的适用范围 */
  appliesTo: string
  /** 实际装的版本 */
  installedVersion: string | null
  /** 装的正是作者写补丁时那个版本 */
  exactMatch: boolean
  /** 落在作者声明的适用范围内 */
  inRange: boolean
  /** 已写进 patchedDependencies */
  declared: boolean
  reason: string | null
}

export interface PluginEntry {
  name: string
  version: string | null
  description: string | null
  profile: string
  channel: PluginChannel
  /** 声明了 dsh.bundle.patch，即会加入 profile 的层叠 */
  isBundle: boolean
  /** 声明了 dsh.client，即带浏览器半边 UI */
  hasClient: boolean
  /** 带 client 却没构建出 lib/client.js —— 装上也不会有 UI，要显式提示 */
  clientBundleMissing: boolean
  /** 注入器报告的运行时活跃状态；拿不到为 null（不等于 false） */
  active: boolean | null
  /** 已标记卸载、等待重启生效 */
  pendingRemoval: boolean
  /** patch 里被 disabled */
  disabled: boolean
  /** 本地目录（桌面端自管的插件解压目录） */
  dir: string | null
  /** 该插件携带的代码级补丁；空数组表示它只做挂载、不碰宿主代码 */
  corePatches: CorePatchInfo[]
}

export interface PluginsState {
  /** 注入器在不在。不在则热更新通道不可用，只能走官方装配 + 重启 */
  injectorAvailable: boolean
  /** 有条目被标记卸载/禁用，等待重启 */
  restartRequired: boolean
  entries: PluginEntry[]
  /** cordis.patch.yml 体检结果 */
  patchHealth: PatchHealth
}

export interface PatchHealth {
  profile: string
  path: string
  /** 重复的 loader entry id —— 会让 dsh 启动即崩，最高优先级 */
  duplicateIds: string[]
  /** 指向已不存在的包的 disabled 条目 */
  orphanDisabled: string[]
  /** YAML 解析失败（例如出现两个顶层值） */
  parseError: string | null
}

/** 安装后的识别闭环：文件落盘不等于 dsh 认到了，逐步验并如实报卡在哪。 */
export interface RecognitionStep {
  step: 'resolvable' | 'injector-active' | 'inventory-active' | 'capability'
  label: string
  ok: boolean
  /** 未执行（例如上一步就断了，或该步不适用） */
  skipped: boolean
  detail: string | null
}

export interface InstallOutcome {
  name: string | null
  channel: PluginChannel
  steps: RecognitionStep[]
  /** 全链路通过 */
  recognized: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// 对外桥接接口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 桥接配置 —— 刻意只有一个开关。
 *
 * 端口、超时、并发、目录范围都用固定默认值，不做成用户可调项：
 * 这个接口的定位是「直接用 app 正在用的那套」，多一个旋钮就多一处
 * 要解释、要出错的地方。token 自动生成并嵌进接入命令，用户不用看见。
 */
export interface BridgeConfig {
  enabled: boolean
}

export interface BridgeStatus {
  running: boolean
  port: number | null
  /** 当前 token，面板可查看与轮换 */
  token: string
  inflight: number
  totalServed: number
  lastError: string | null
  /** 给 Claude Code 的接入命令，面板一键复制 */
  mcpCommand: string
  /** 当前在用的模型描述 —— 与聊天共用同一份全局配置，调用方无需指定 */
  model: string
  /** 固定不变的运行参数，仅供面板只读展示 */
  limits: { timeoutMs: number; maxConcurrent: number }
}

// ─────────────────────────────────────────────────────────────────────────────
// 通道定义
// ─────────────────────────────────────────────────────────────────────────────

/** 请求/响应型通道：渲染层 invoke，主进程 handle。 */
export interface InvokeMap {
  'app:info': () => AppInfo
  'app:openLogDir': () => OpResult
  'app:openExternal': (url: string) => OpResult

  'view:setBounds': (rect: Rect) => void
  'view:setVisible': (visible: boolean) => void
  'view:reload': () => void

  'backend:status': () => BackendStatus
  'backend:restart': () => OpResult
  'backend:stop': () => OpResult

  'log:tail': (limit: number) => LogLine[]

  'update:state': () => UpdateReport
  'update:check': () => OpResult<UpdateReport>
  'update:upgradeCli': () => OpResult<string>
  'update:pullSourceRepo': () => OpResult<string>
  'update:appDownload': () => OpResult
  'update:appInstall': () => OpResult

  'plugins:state': () => PluginsState
  'plugins:refresh': () => OpResult<PluginsState>
  'plugins:install': (args: { spec: string; channel: 'injected' | 'official' }) => OpResult<InstallOutcome>
  'plugins:uninstall': (args: { name: string }) => OpResult<string>
  'plugins:setDisabled': (args: { name: string; disabled: boolean }) => OpResult<string>
  'plugins:patchDoctor': (args: { fix: boolean }) => OpResult<PatchHealth>


  'bridge:status': () => BridgeStatus
  'bridge:config': () => BridgeConfig
  'bridge:setConfig': (patch: Partial<BridgeConfig>) => OpResult<BridgeConfig>
  'bridge:rotateToken': () => OpResult<string>
}

/** 主进程主动推给渲染层的事件。 */
export interface EventMap {
  'backend:changed': BackendStatus
  'log:line': LogLine
  'update:changed': UpdateReport
  'plugins:changed': PluginsState
  'bridge:changed': BridgeStatus
  /** 主进程要求渲染层切到某个面板（托盘菜单点击等） */
  'nav:goto': { panel: string }
}

export const INVOKE_CHANNELS = [
  'app:info', 'app:openLogDir', 'app:openExternal',
  'view:setBounds', 'view:setVisible', 'view:reload',
  'backend:status', 'backend:restart', 'backend:stop',
  'log:tail',
  'update:state', 'update:check', 'update:upgradeCli', 'update:pullSourceRepo',
  'update:appDownload', 'update:appInstall',
  'plugins:state', 'plugins:refresh', 'plugins:install', 'plugins:uninstall',
  'plugins:setDisabled', 'plugins:patchDoctor',
  'bridge:status', 'bridge:config', 'bridge:setConfig', 'bridge:rotateToken',
] as const satisfies ReadonlyArray<keyof InvokeMap>

export const EVENT_CHANNELS = [
  'backend:changed', 'log:line', 'update:changed',
  'plugins:changed', 'bridge:changed', 'nav:goto',
] as const satisfies ReadonlyArray<keyof EventMap>

/** preload 在 window.dsh 上暴露的形状。 */
export type DshBridgeApi = {
  [K in keyof InvokeMap]: (...args: Parameters<InvokeMap[K]>) => Promise<ReturnType<InvokeMap[K]>>
} & {
  on<K extends keyof EventMap>(channel: K, listener: (payload: EventMap[K]) => void): () => void
}
