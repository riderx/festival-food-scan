import { NetworkDiagnostics } from '@capgo/capacitor-network-diagnostics'
import { useCallback, useEffect, useState } from 'react'
import type { NetworkStatusResult } from '@capgo/capacitor-network-diagnostics'

type NavigatorConnection = {
  effectiveType?: string
  downlink?: number
  rtt?: number
  saveData?: boolean
}

type NavigatorWithConnection = Navigator & {
  connection?: NavigatorConnection
  mozConnection?: NavigatorConnection
  webkitConnection?: NavigatorConnection
}

export type NetworkQuality = 'ok' | 'unknown' | 'low' | 'very-low' | 'offline' | 'unreachable'

export type NetworkDiagnosticsState = {
  connected: boolean
  internetReachable: boolean
  connectionType: NetworkStatusResult['connectionType']
  quality: NetworkQuality
  remoteUsable: boolean
  reason: string
  checkedAt?: string
  error?: string
}

const diagnosticsTimeoutMs = 900

const fallbackStatus = (): NetworkDiagnosticsState => {
  const navigator = globalThis.navigator as NavigatorWithConnection | undefined
  const connection = navigator?.connection ?? navigator?.mozConnection ?? navigator?.webkitConnection
  const details: Record<string, string | number | boolean> = {}
  if (connection?.effectiveType) {
    details.effectiveType = connection.effectiveType
  }
  if (typeof connection?.downlink === 'number') {
    details.downlinkMbps = connection.downlink
  }
  if (typeof connection?.rtt === 'number') {
    details.rttMs = connection.rtt
  }

  return networkStateFromStatus({
    connected: navigator?.onLine ?? true,
    internetReachable: navigator?.onLine ?? true,
    connectionType: navigator?.onLine === false ? 'none' : 'unknown',
    constrained: connection?.saveData,
    details,
  })
}

export function useNetworkDiagnostics() {
  const [status, setStatus] = useState<NetworkDiagnosticsState>(fallbackStatus)

  const refresh = useCallback(async () => {
    try {
      const networkStatus = await withTimeout(NetworkDiagnostics.getNetworkStatus(), diagnosticsTimeoutMs)
      const nextStatus = networkStateFromStatus(networkStatus)
      setStatus(nextStatus)
      return nextStatus
    } catch (error) {
      const nextStatus = {
        ...fallbackStatus(),
        error: error instanceof Error ? error.message : 'Network status unavailable',
      }
      setStatus(nextStatus)
      return nextStatus
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

function networkStateFromStatus(status: NetworkStatusResult): NetworkDiagnosticsState {
  const detail = status.details ?? {}
  const effectiveType = readString(detail.effectiveType)
  const downlinkMbps = readNumber(detail.downlinkMbps)
  const rttMs = readNumber(detail.rttMs)
  const quality = networkQuality(status, effectiveType, downlinkMbps, rttMs)
  return {
    connected: status.connected,
    internetReachable: status.internetReachable,
    connectionType: status.connectionType,
    quality,
    remoteUsable: quality === 'ok' || quality === 'unknown',
    reason: networkReason(status, quality, effectiveType, downlinkMbps, rttMs),
    checkedAt: new Date().toISOString(),
  }
}

function networkQuality(
  status: NetworkStatusResult,
  effectiveType?: string,
  downlinkMbps?: number,
  rttMs?: number,
): NetworkQuality {
  if (!status.connected || status.connectionType === 'none') {
    return 'offline'
  }
  if (!status.internetReachable || status.captivePortal) {
    return 'unreachable'
  }
  if (status.constrained || effectiveType === 'slow-2g' || effectiveType === '2g' || (downlinkMbps !== undefined && downlinkMbps < 0.25) || (rttMs !== undefined && rttMs > 3000)) {
    return 'very-low'
  }
  if (effectiveType === '3g' || (downlinkMbps !== undefined && downlinkMbps < 0.7) || (rttMs !== undefined && rttMs > 1600)) {
    return 'low'
  }
  if (status.connectionType === 'unknown') {
    return 'unknown'
  }
  return 'ok'
}

function networkReason(
  status: NetworkStatusResult,
  quality: NetworkQuality,
  effectiveType?: string,
  downlinkMbps?: number,
  rttMs?: number,
): string {
  switch (quality) {
    case 'offline':
      return 'No network'
    case 'unreachable':
      return status.captivePortal ? 'Captive portal' : 'No internet'
    case 'very-low':
      return status.constrained ? 'Very low network' : speedReason('Very low network', effectiveType, downlinkMbps, rttMs)
    case 'low':
      return speedReason('Low network', effectiveType, downlinkMbps, rttMs)
    case 'unknown':
      return 'Network unknown'
    case 'ok':
      return 'Network ready'
  }
}

function speedReason(label: string, effectiveType?: string, downlinkMbps?: number, rttMs?: number): string {
  if (effectiveType) {
    return `${label} (${effectiveType})`
  }
  if (downlinkMbps !== undefined) {
    return `${label} (${downlinkMbps.toFixed(1)} Mbps)`
  }
  if (rttMs !== undefined) {
    return `${label} (${Math.round(rttMs)} ms)`
  }
  return label
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: number | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error('Network diagnostics timeout')), timeoutMs)
      }),
    ])
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId)
    }
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
