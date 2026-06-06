import { CameraPreview } from '@capgo/camera-preview'
import type { BarcodeScannedEvent } from '@capgo/camera-preview'
import { Capacitor } from '@capacitor/core'
import { useCallback, useEffect, useRef, useState } from 'react'

type UseCapgoQrScannerOptions = {
  enabled: boolean
  onScan: (value: string) => void | Promise<void>
  previewSelector?: string
}

type ListenerHandle = {
  remove: () => Promise<void>
}

type PreviewBounds = {
  x: number
  y: number
  width: number
  height: number
}

type CameraTask = () => Promise<void>

const duplicateWindowMs = 1800
const defaultPreviewSelector = '.scanner-stage'
const cameraStopTimeoutMs = 1200
const cameraStartTimeoutMs = 5000

function measurePreviewBounds(selector: string): PreviewBounds {
  const target = document.querySelector<HTMLElement>(selector)
  const rect = target?.getBoundingClientRect()

  if (!rect || rect.width < 1 || rect.height < 1) {
    return {
      x: 0,
      y: 0,
      width: Math.max(1, Math.round(window.innerWidth)),
      height: Math.max(1, Math.round(window.innerHeight)),
    }
  }

  return {
    x: Math.max(0, Math.round(rect.left)),
    y: Math.max(0, Math.round(rect.top)),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  }
}

function previewBoundsForPlatform(bounds: PreviewBounds): PreviewBounds {
  if (Capacitor.getPlatform() === 'web') {
    return {
      ...bounds,
      x: 0,
      y: 0,
    }
  }

  return bounds
}

function samePreviewBounds(left: PreviewBounds | null, right: PreviewBounds): boolean {
  return Boolean(
    left &&
      left.x === right.x &&
      left.y === right.y &&
      left.width === right.width &&
      left.height === right.height,
  )
}

async function withCameraTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: number | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId)
    }
  }
}

export function useCapgoQrScanner({
  enabled,
  onScan,
  previewSelector = defaultPreviewSelector,
}: UseCapgoQrScannerOptions) {
  const [active, setActive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const onScanRef = useRef(onScan)
  const lastScanRef = useRef({ value: '', time: 0 })
  const listenerHandlesRef = useRef<ListenerHandle[]>([])
  const activeRef = useRef(false)
  const enabledRef = useRef(enabled)
  const cameraTaskRef = useRef<Promise<void>>(Promise.resolve())
  const lastPreviewBoundsRef = useRef<PreviewBounds | null>(null)
  const resizeTimerRef = useRef<number | undefined>(undefined)
  const restartTimerRef = useRef<number | undefined>(undefined)
  const restartingRef = useRef(false)
  enabledRef.current = enabled

  useEffect(() => {
    onScanRef.current = onScan
  }, [onScan])

  const setActiveState = useCallback((value: boolean) => {
    activeRef.current = value
    setActive(value)
  }, [])

  const enqueueCameraTask = useCallback((task: CameraTask) => {
    const nextTask = cameraTaskRef.current.catch(() => undefined).then(task)
    cameraTaskRef.current = nextTask.catch(() => undefined)
    return nextTask
  }, [])

  const removeListeners = useCallback(async () => {
    const handles = listenerHandlesRef.current
    listenerHandlesRef.current = []
    await Promise.all(handles.map((handle) => handle.remove().catch(() => undefined)))
  }, [])

  const stop = useCallback(async () => {
    await enqueueCameraTask(async () => {
      if (resizeTimerRef.current !== undefined) {
        window.clearTimeout(resizeTimerRef.current)
        resizeTimerRef.current = undefined
      }
      await withCameraTimeout(
        CameraPreview.stopBarcodeScanner(),
        cameraStopTimeoutMs,
        'Camera barcode stop timeout',
      ).catch(() => undefined)
      await withCameraTimeout(CameraPreview.stop(), cameraStopTimeoutMs, 'Camera preview stop timeout').catch(
        () => undefined,
      )
      await removeListeners()
      lastPreviewBoundsRef.current = null
      setActiveState(false)
    })
  }, [enqueueCameraTask, removeListeners, setActiveState])

  const syncPreviewBounds = useCallback(async () => {
    if (!activeRef.current) {
      return
    }

    const measuredBounds = measurePreviewBounds(previewSelector)
    if (samePreviewBounds(lastPreviewBoundsRef.current, measuredBounds)) {
      return
    }

    lastPreviewBoundsRef.current = measuredBounds
    await CameraPreview.setPreviewSize(previewBoundsForPlatform(measuredBounds)).catch((resizeError: unknown) => {
      setError(resizeError instanceof Error ? resizeError.message : 'Camera resize failed')
    })
  }, [previewSelector])

  const start = useCallback(async () => {
    await enqueueCameraTask(async () => {
      if (!enabledRef.current || document.hidden) {
        setActiveState(false)
        return
      }

      setError(null)
      await removeListeners()

      const permission = await CameraPreview.requestPermissions({
        disableAudio: true,
        showSettingsAlert: true,
        title: 'Camera permission',
        message: 'Camera access is needed for food pass scanning.',
      })

      if (permission.camera !== 'granted') {
        throw new Error('Camera permission denied')
      }

      if (!enabledRef.current || document.hidden) {
        await removeListeners()
        setActiveState(false)
        return
      }

      const barcodeHandle = await CameraPreview.addListener('barcodeScanned', (event: BarcodeScannedEvent) => {
        const value = event.barcodes.find((barcode) => barcode.value)?.value
        if (!value) {
          return
        }

        const now = Date.now()
        if (lastScanRef.current.value === value && now - lastScanRef.current.time < duplicateWindowMs) {
          return
        }

        lastScanRef.current = { value, time: now }
        void onScanRef.current(value)
      })

      const errorHandle = await CameraPreview.addListener('barcodeScanError', ({ message }) => {
        setError(message)
      })

      listenerHandlesRef.current = [barcodeHandle, errorHandle]

      const measuredBounds = measurePreviewBounds(previewSelector)
      lastPreviewBoundsRef.current = measuredBounds

      await withCameraTimeout(
        CameraPreview.start({
          parent: 'camera-preview',
          className: 'native-camera-preview',
          ...previewBoundsForPlatform(measuredBounds),
          position: 'rear',
          toBack: true,
          aspectMode: 'cover',
          disableAudio: true,
          force: true,
          barcodeScanner: {
            formats: ['qr_code'],
            detectionInterval: 500,
          },
        }),
        cameraStartTimeoutMs,
        'Camera preview start timeout',
      )

      if (!enabledRef.current || document.hidden) {
        await withCameraTimeout(
          CameraPreview.stopBarcodeScanner(),
          cameraStopTimeoutMs,
          'Camera barcode stop timeout',
        ).catch(() => undefined)
        await withCameraTimeout(CameraPreview.stop(), cameraStopTimeoutMs, 'Camera preview stop timeout').catch(
          () => undefined,
        )
        await removeListeners()
        lastPreviewBoundsRef.current = null
        setActiveState(false)
        return
      }

      setActiveState(true)
    })
  }, [enqueueCameraTask, previewSelector, removeListeners, setActiveState])

  useEffect(() => {
    if (!enabled) {
      return
    }

    const schedulePreviewSync = () => {
      if (resizeTimerRef.current !== undefined) {
        window.clearTimeout(resizeTimerRef.current)
      }

      resizeTimerRef.current = window.setTimeout(() => {
        void syncPreviewBounds()
      }, 120)
    }

    window.addEventListener('resize', schedulePreviewSync)
    window.addEventListener('orientationchange', schedulePreviewSync)
    window.visualViewport?.addEventListener('resize', schedulePreviewSync)

    return () => {
      window.removeEventListener('resize', schedulePreviewSync)
      window.removeEventListener('orientationchange', schedulePreviewSync)
      window.visualViewport?.removeEventListener('resize', schedulePreviewSync)
      if (resizeTimerRef.current !== undefined) {
        window.clearTimeout(resizeTimerRef.current)
        resizeTimerRef.current = undefined
      }
    }
  }, [enabled, syncPreviewBounds])

  useEffect(() => {
    if (!enabled) {
      return
    }

    const clearRestartTimer = () => {
      if (restartTimerRef.current !== undefined) {
        window.clearTimeout(restartTimerRef.current)
        restartTimerRef.current = undefined
      }
    }

    const pauseForBackground = () => {
      clearRestartTimer()
      void stop()
    }

    const scheduleRestart = () => {
      clearRestartTimer()
      restartTimerRef.current = window.setTimeout(() => {
        if (!enabledRef.current || document.hidden || restartingRef.current) {
          return
        }

        restartingRef.current = true
        void stop()
          .then(() => {
            if (!enabledRef.current || document.hidden) {
              return undefined
            }
            return start()
          })
          .catch((restartError: unknown) => {
            setActiveState(false)
            setError(restartError instanceof Error ? restartError.message : 'Camera restart failed')
          })
          .finally(() => {
            restartingRef.current = false
          })
      }, 260)
    }

    const handleVisibilityChange = () => {
      if (document.hidden) {
        pauseForBackground()
        return
      }
      scheduleRestart()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    document.addEventListener('freeze', pauseForBackground)
    document.addEventListener('pause', pauseForBackground)
    document.addEventListener('resume', scheduleRestart)
    window.addEventListener('pagehide', pauseForBackground)
    window.addEventListener('pageshow', scheduleRestart)
    window.addEventListener('blur', pauseForBackground)
    window.addEventListener('focus', scheduleRestart)

    return () => {
      clearRestartTimer()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      document.removeEventListener('freeze', pauseForBackground)
      document.removeEventListener('pause', pauseForBackground)
      document.removeEventListener('resume', scheduleRestart)
      window.removeEventListener('pagehide', pauseForBackground)
      window.removeEventListener('pageshow', scheduleRestart)
      window.removeEventListener('blur', pauseForBackground)
      window.removeEventListener('focus', scheduleRestart)
    }
  }, [enabled, start, stop])

  useEffect(() => {
    if (!enabled) {
      return
    }

    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    start().catch((startError: unknown) => {
      if (cancelled) {
        return
      }
      setActive(false)
      setError(startError instanceof Error ? startError.message : 'Camera start failed')
    })

    return () => {
      cancelled = true
      void stop()
    }
  }, [enabled, start, stop])

  return {
    active,
    error,
    restart: start,
    stop,
  }
}
