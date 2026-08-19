import type { DshBridgeApi } from '@shared/ipc'
declare global {
  interface Window { dsh: DshBridgeApi }
}
export {}
