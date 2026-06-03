import { AlertTriangle, CheckCircle2, CircleDollarSign, Loader2, RotateCcw, ScanLine, Settings, ShieldX, Utensils } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import './App.css'
import { parseQrPayload, serviceDayFor, validateFoodPass } from './domain/mealPass'
import type { FoodPassResult, FoodPassStatus } from './domain/mealPass'
import { useCapgoQrScanner } from './hooks/useCapgoQrScanner'

type ScanEvent = FoodPassResult & {
  id: string
  raw: string
}

type CurrentScan = Omit<ScanEvent, 'status'> & {
  status: FoodPassStatus | 'checking'
}

type ScanStats = Record<FoodPassStatus, number>

const emptyStats: ScanStats = {
  ok: 0,
  already_used: 0,
  needs_payment: 0,
  not_found: 0,
  error: 0,
}

const statusIcon = {
  checking: Loader2,
  ok: CheckCircle2,
  already_used: AlertTriangle,
  needs_payment: CircleDollarSign,
  not_found: ShieldX,
  error: ShieldX,
}

const statusLabel = {
  checking: 'Checking pass',
  ok: 'Meal valid',
  already_used: 'Already used',
  needs_payment: 'Payment needed',
  not_found: 'Unknown pass',
  error: 'Check failed',
}

const apiMode = import.meta.env.VITE_VALIDATE_ENDPOINT ? 'Live DB' : 'Demo DB'

function App() {
  const serviceDay = useMemo(() => serviceDayFor(new Date()), [])
  const [locked, setLocked] = useState(false)
  const [currentScan, setCurrentScan] = useState<CurrentScan | null>(null)
  const [recentScans, setRecentScans] = useState<ScanEvent[]>([])
  const [manualValue, setManualValue] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const lockedRef = useRef(false)

  const rememberScan = useCallback((scan: ScanEvent) => {
    setCurrentScan(scan)
    setRecentScans((items) => [scan, ...items].slice(0, 8))
  }, [])

  const handleRawScan = useCallback(
    async (raw: string) => {
      if (lockedRef.current) {
        return
      }

      lockedRef.current = true
      setLocked(true)

      const parsed = parseQrPayload(raw)
      const pendingScan: ScanEvent = {
        id: crypto.randomUUID(),
        raw,
        status: 'ok',
        title: 'Checking pass',
        message: 'Database validation running',
        serviceDay,
        token: parsed.token,
      }

      setCurrentScan({ ...pendingScan, status: 'checking' })

      try {
        const result = await validateFoodPass(parsed, serviceDay)
        rememberScan({
          ...result,
          id: pendingScan.id,
          raw,
        })

        if (result.status === 'ok' && 'vibrate' in navigator) {
          navigator.vibrate(80)
        }
      } catch (error) {
        rememberScan({
          id: pendingScan.id,
          raw,
          status: 'error',
          title: 'Check failed',
          message: error instanceof Error ? error.message : 'Validation failed',
          serviceDay,
          token: parsed.token,
        })
      }
    },
    [rememberScan, serviceDay],
  )

  const scanner = useCapgoQrScanner({
    enabled: true,
    onScan: handleRawScan,
  })

  const stats = useMemo(
    () =>
      recentScans.reduce<ScanStats>(
        (acc, scan) => ({
          ...acc,
          [scan.status]: acc[scan.status] + 1,
        }),
        emptyStats,
      ),
    [recentScans],
  )

  const releaseScanner = () => {
    lockedRef.current = false
    setLocked(false)
    setCurrentScan(null)
  }

  const runManualScan = () => {
    const value = manualValue.trim()
    if (!value) {
      return
    }
    setManualValue('')
    void handleRawScan(value)
  }

  const currentStatus = currentScan?.status ?? 'error'
  const CurrentIcon = currentScan ? statusIcon[currentStatus] : ScanLine

  return (
    <main className="app-shell">
      <div id="camera-preview" aria-hidden="true" />

      <header className="top-bar">
        <div className="brand-lockup" aria-label="Festival Food Scan">
          <span className="brand-mark">
            <Utensils size={18} aria-hidden="true" />
          </span>
          <div>
            <h1>Festival Food Scan</h1>
            <p>{serviceDay}</p>
          </div>
        </div>

        <div className="top-actions">
          <span className={`mode-pill ${apiMode === 'Live DB' ? 'live' : 'demo'}`}>{apiMode}</span>
          <button
            className="icon-button"
            type="button"
            aria-label="Settings"
            title="Settings"
            onClick={() => setShowSettings((value) => !value)}
          >
            <Settings size={18} aria-hidden="true" />
          </button>
        </div>
      </header>

      <section className={`scanner-stage ${locked ? 'locked' : ''}`} aria-label="Scanner">
        <div className="scan-frame">
          <div className="corner top-left" />
          <div className="corner top-right" />
          <div className="corner bottom-left" />
          <div className="corner bottom-right" />
          {!locked && <ScanLine className="scan-line-icon" size={34} aria-hidden="true" />}
        </div>
      </section>

      <aside className="status-dock" aria-live="polite">
        <div className={`result-strip ${currentScan ? currentStatus : 'idle'}`}>
          <span className="result-icon">
            <CurrentIcon size={22} aria-hidden="true" />
          </span>
          <div className="result-copy">
            <strong>{currentScan ? statusLabel[currentStatus] : scanner.active ? 'Ready to scan' : 'Camera starting'}</strong>
            <span>{currentScan?.personLabel ?? currentScan?.message ?? scanner.error ?? 'QR code inside frame'}</span>
          </div>
          <button className="primary-action" type="button" onClick={releaseScanner} disabled={!locked}>
            <RotateCcw size={17} aria-hidden="true" />
            Scan next
          </button>
        </div>

        <div className="stats-grid" aria-label="Today stats">
          <div>
            <strong>{stats.ok}</strong>
            <span>Valid</span>
          </div>
          <div>
            <strong>{stats.already_used + stats.needs_payment + stats.not_found + stats.error}</strong>
            <span>Blocked</span>
          </div>
          <div>
            <strong>{recentScans.length}</strong>
            <span>Total</span>
          </div>
        </div>

        {showSettings && (
          <div className="settings-panel">
            <label htmlFor="manual-qr">Manual QR</label>
            <div className="manual-row">
              <input
                id="manual-qr"
                value={manualValue}
                onChange={(event) => setManualValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    runManualScan()
                  }
                }}
                placeholder="Token or JSON payload"
              />
              <button type="button" onClick={runManualScan}>
                Scan
              </button>
            </div>
            <dl>
              <div>
                <dt>Endpoint</dt>
                <dd>{import.meta.env.VITE_VALIDATE_ENDPOINT ? 'Configured' : 'Local demo'}</dd>
              </div>
              <div>
                <dt>Camera</dt>
                <dd>{scanner.active ? 'Active' : scanner.error ? 'Error' : 'Starting'}</dd>
              </div>
            </dl>
          </div>
        )}

        {recentScans.length > 0 && (
          <div className="recent-list" aria-label="Recent scans">
            {recentScans.map((scan) => (
              <div className={`recent-row ${scan.status}`} key={scan.id}>
                <span>{statusLabel[scan.status]}</span>
                <strong>{scan.personLabel ?? scan.token}</strong>
              </div>
            ))}
          </div>
        )}
      </aside>
    </main>
  )
}

export default App
