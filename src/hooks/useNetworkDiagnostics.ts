import { NetworkDiagnostics } from '@capgo/capacitor-network-diagnostics'
import { useCallback, useEffect, useState } from 'react'
import type { NetworkStatusResult } from '@capgo/capacitor-network-diagnostics'

export type NetworkDiagnosticsState = {
  connected: boolean
  internetReachable: boolean
  connectionType: NetworkStatusResult['connectionType']
  checkedAt?: string
  error?: string
}

const fallbackStatus = (): NetworkDiagnosticsState => ({
  connected: globalThis.navigator?.onLine ?? true,
  internetReachable: globalThis.navigator?.onLine ?? true,
  connectionType: globalThis.navigator?.onLine === false ? 'none' : 'unknown',
  checkedAt: new Date().toISOString(),
})

export function useNetworkDiagnostics() {
  const [status, setStatus] = useState<NetworkDiagnosticsState>(fallbackStatus)

  const refresh = useCallback(async () => {
    try {
      const networkStatus = await NetworkDiagnostics.getNetworkStatus()
      setStatus({
        connected: networkStatus.connected,
        internetReachable: networkStatus.internetReachable,
        connectionType: networkStatus.connectionType,
        checkedAt: new Date().toISOString(),
      })
    } catch (error) {
      setStatus({
        ...fallbackStatus(),
        error: error instanceof Error ? error.message : 'Network status unavailable',
      })
    }
  }, [])

  useEffect(() => {
    const initialTimer = window.setTimeout(() => {
      void refresh()
    }, 0)
    const interval = window.setInterval(() => {
      void refresh()
    }, 10000)

    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(interval)
    }
  }, [refresh])

  return {
    ...status,
    refresh,
    online: status.connected && status.internetReachable,
  }
}
