import { CameraPreview } from '@capgo/camera-preview'
import type { BarcodeScannedEvent } from '@capgo/camera-preview'
import { useCallback, useEffect, useRef, useState } from 'react'

type UseCapgoQrScannerOptions = {
  enabled: boolean
  onScan: (value: string) => void | Promise<void>
}

type ListenerHandle = {
  remove: () => Promise<void>
}

const duplicateWindowMs = 1800

export function useCapgoQrScanner({ enabled, onScan }: UseCapgoQrScannerOptions) {
  const [active, setActive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const onScanRef = useRef(onScan)
  const lastScanRef = useRef({ value: '', time: 0 })
  const listenerHandlesRef = useRef<ListenerHandle[]>([])

  useEffect(() => {
    onScanRef.current = onScan
  }, [onScan])

  const removeListeners = useCallback(async () => {
    const handles = listenerHandlesRef.current
    listenerHandlesRef.current = []
    await Promise.all(handles.map((handle) => handle.remove().catch(() => undefined)))
  }, [])

  const stop = useCallback(async () => {
    await CameraPreview.stopBarcodeScanner().catch(() => undefined)
    await CameraPreview.stop().catch(() => undefined)
    await removeListeners()
    setActive(false)
  }, [removeListeners])

  const start = useCallback(async () => {
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

    await CameraPreview.start({
      parent: 'camera-preview',
      className: 'native-camera-preview',
      position: 'rear',
      toBack: true,
      aspectRatio: 'fill',
      aspectMode: 'cover',
      disableAudio: true,
      force: true,
      barcodeScanner: {
        formats: ['qr_code'],
        detectionInterval: 500,
      },
    })

    setActive(true)
  }, [removeListeners])

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
