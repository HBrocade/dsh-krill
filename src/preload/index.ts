/**
 * preload：按 ipc.ts 的白名单逐个暴露，**不透传裸 invoke**。
 *
 * 这个进程里除了我们的外壳，同一棵进程树上还挂着 dsh 的 SPA。
 * 透传 `ipcRenderer.invoke` 等于把主进程全部能力敞开，白名单是这里的第一道闸。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { INVOKE_CHANNELS, EVENT_CHANNELS } from '@shared/ipc'

const api: Record<string, unknown> = {}

for (const channel of INVOKE_CHANNELS) {
  api[channel] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)
}

api['on'] = (channel: string, listener: (payload: unknown) => void): (() => void) => {
  if (!(EVENT_CHANNELS as readonly string[]).includes(channel)) {
    throw new Error(`未知事件通道：${channel}`)
  }
  const wrapped = (_e: unknown, payload: unknown): void => { listener(payload) }
  ipcRenderer.on(channel, wrapped)
  return () => { ipcRenderer.removeListener(channel, wrapped) }
}

contextBridge.exposeInMainWorld('dsh', api)
