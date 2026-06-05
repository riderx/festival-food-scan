import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left.mjs'
import CheckCircle2 from 'lucide-react/dist/esm/icons/check-circle-2.mjs'
import CircleDollarSign from 'lucide-react/dist/esm/icons/circle-dollar-sign.mjs'
import CloudCheck from 'lucide-react/dist/esm/icons/cloud-check.mjs'
import CloudUpload from 'lucide-react/dist/esm/icons/cloud-upload.mjs'
import DatabaseZap from 'lucide-react/dist/esm/icons/database-zap.mjs'
import Loader2 from 'lucide-react/dist/esm/icons/loader-2.mjs'
import RefreshCw from 'lucide-react/dist/esm/icons/refresh-cw.mjs'
import ScanLine from 'lucide-react/dist/esm/icons/scan-line.mjs'
import ShieldX from 'lucide-react/dist/esm/icons/shield-x.mjs'
import TriangleAlert from 'lucide-react/dist/esm/icons/triangle-alert.mjs'
import Utensils from 'lucide-react/dist/esm/icons/utensils.mjs'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { parseQrPayload, serviceDayFor, validateFoodPass } from './domain/mealPass'
import type { FoodPassResult, FoodPassStatus } from './domain/mealPass'
import { mealSessionByKey, mealSessionGroups, mealSessions } from './domain/mealSessions'
import {
  hasNocoDbConfig,
  loadCachedSnapshot,
  pendingScanCount,
  refreshScanSessionSnapshot,
  startScanSession,
  syncPendingScans,
  validateOfflineArrival,
  validateOfflineScan,
} from './domain/nocoDbOffline'
import type { ScanSessionSnapshot } from './domain/nocoDbOffline'
import { useCapgoQrScanner } from './hooks/useCapgoQrScanner'
import { useNetworkDiagnostics } from './hooks/useNetworkDiagnostics'
import type { NetworkDiagnosticsState } from './hooks/useNetworkDiagnostics'

type ScanEvent = FoodPassResult & {
  id: string
  raw: string
}

type CurrentScan = Omit<ScanEvent, 'status'> & {
  status: FoodPassStatus | 'checking'
}

type ScanStats = Record<FoodPassStatus, number>
type SessionState = 'setup' | 'loading' | 'scanning'
type ScanTargetKind = 'arrival' | 'meal'

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
  already_used: TriangleAlert,
  needs_payment: CircleDollarSign,
  not_found: ShieldX,
  error: ShieldX,
}

const statusLabel = {
  checking: 'Vérification',
  ok: 'Oui, suivant',
  already_used: 'Déjà fait',
  needs_payment: 'Non payé',
  not_found: 'Inconnu',
  error: 'Erreur',
}

const apiMode = hasNocoDbConfig() ? 'NocoDB' : 'Demo'
const autoReleaseMs = 1450
const preScanRefreshTimeoutMs = 1200
const startScanRemoteTimeoutMs = 1800
const syncWriteTimeoutMs = 1500
const arrivalTarget = {
  kind: 'arrival' as const,
  key: 'arrival',
  label: 'Entrée festival',
}

function App() {
  const serviceDay = useMemo(() => serviceDayFor(new Date()), [])
  const [selectedTargetKind, setSelectedTargetKind] = useState<ScanTargetKind>('meal')
  const [selectedMealKey, setSelectedMealKey] = useState(mealSessions[0].key)
  const selectedMeal = useMemo(() => mealSessionByKey(selectedMealKey), [selectedMealKey])
  const selectedTarget = useMemo(
    () => (selectedTargetKind === 'arrival' ? arrivalTarget : { ...selectedMeal, kind: 'meal' as const }),
    [selectedMeal, selectedTargetKind],
  )
  const [sessionState, setSessionState] = useState<SessionState>('setup')
  const [snapshot, setSnapshot] = useState<ScanSessionSnapshot | null>(() => loadCachedSnapshot())
  const [locked, setLocked] = useState(false)
  const [currentScan, setCurrentScan] = useState<CurrentScan | null>(null)
  const [recentScans, setRecentScans] = useState<ScanEvent[]>([])
  const [pendingCount, setPendingCount] = useState(() => pendingScanCount())
  const [sessionMessage, setSessionMessage] = useState('')
  const [syncMessage, setSyncMessage] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [refreshingDb, setRefreshingDb] = useState(false)
  const [freshnessError, setFreshnessError] = useState('')
  const lockedRef = useRef(false)
  const releaseTimerRef = useRef<number | undefined>(undefined)
  const syncInFlightRef = useRef(false)
  const network = useNetworkDiagnostics()
  const refreshNetwork = network.refresh

  const rememberScan = useCallback((scan: ScanEvent) => {
    setCurrentScan(scan)
    setRecentScans((items) => [scan, ...items].slice(0, 10))
  }, [])

  const clearReleaseTimer = useCallback(() => {
    if (releaseTimerRef.current !== undefined) {
      window.clearTimeout(releaseTimerRef.current)
      releaseTimerRef.current = undefined
    }
  }, [])

  const releaseScanner = useCallback(() => {
    lockedRef.current = false
    setLocked(false)
  }, [])

  const scheduleRelease = useCallback(() => {
    clearReleaseTimer()
    releaseTimerRef.current = window.setTimeout(() => {
      releaseScanner()
    }, autoReleaseMs)
  }, [clearReleaseTimer, releaseScanner])

  const syncQueuedWrites = useCallback(async (visible: boolean) => {
    if (syncInFlightRef.current) {
      return
    }

    syncInFlightRef.current = true
    setSyncing(true)
    if (visible) {
      setSyncMessage('Sync in progress')
    }

    try {
      const latestNetwork = await refreshNetwork()
      const currentPendingCount = pendingScanCount()
      setPendingCount(currentPendingCount)

      if (currentPendingCount === 0) {
        if (visible) {
          setSyncMessage('No pending writes')
        }
        return
      }

      if (!latestNetwork.remoteUsable) {
        const message = `Local queue kept: ${latestNetwork.reason}`
        setFreshnessError(message)
        if (visible) {
          setSyncMessage(message)
        }
        return
      }

      const result = await syncPendingScans({ timeoutMs: syncWriteTimeoutMs })
      setPendingCount(result.pendingCount)
      if (visible || result.syncedCount > 0 || result.failedCount > 0) {
        setSyncMessage(result.message)
      }
      if (result.failedCount > 0) {
        setFreshnessError('Sync failed, local queue kept')
      } else if (result.pendingCount === 0) {
        setFreshnessError('')
      }
    } finally {
      syncInFlightRef.current = false
      setSyncing(false)
    }
  }, [refreshNetwork])

  const refreshSnapshotForScan = useCallback(async (): Promise<ScanSessionSnapshot | null> => {
    if (!hasNocoDbConfig()) {
      setFreshnessError('')
      return snapshot
    }

    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), preScanRefreshTimeoutMs)
    setRefreshingDb(true)
    setFreshnessError('')

    try {
      const latestNetwork = await refreshNetwork()
      if (!latestNetwork.remoteUsable) {
        const message = `${latestNetwork.reason}, local cache used`
        setFreshnessError(message)
        setSyncMessage(message)
        return snapshot
      }

      const result = await refreshScanSessionSnapshot(serviceDay, controller.signal, preScanRefreshTimeoutMs)
      setSnapshot(result.snapshot)
      setPendingCount(result.pendingCount)
      setSyncMessage(result.message)
      return result.snapshot
    } catch {
      const message = controller.signal.aborted ? 'DB check skipped, local cache used' : 'DB check failed, local cache used'
      setFreshnessError(message)
      setSyncMessage(message)
      return snapshot
    } finally {
      window.clearTimeout(timeoutId)
      setRefreshingDb(false)
    }
  }, [refreshNetwork, serviceDay, snapshot])

  const startSession = async () => {
    setSessionState('loading')
    setSessionMessage(`Loading ${selectedTarget.label}`)
    setCurrentScan(null)
    setRecentScans([])
    setFreshnessError('')
    clearReleaseTimer()
    releaseScanner()

    try {
      const latestNetwork = await refreshNetwork()
      const skipRemote = hasNocoDbConfig() && !latestNetwork.remoteUsable
      const result = await startScanSession(selectedMeal, serviceDay, {
        skipRemote,
        timeoutMs: startScanRemoteTimeoutMs,
        targetLabel: selectedTarget.label,
      })
      setSnapshot(result.snapshot)
      setPendingCount(result.pendingCount)
      const message = skipRemote ? `${result.message}. ${latestNetwork.reason}.` : result.message
      setSessionMessage(message)
      setSyncMessage(message)
      setFreshnessError(result.source === 'cache' ? cacheModeMessage(latestNetwork) : '')
      setSessionState('scanning')
    } catch (error) {
      setSessionMessage(error instanceof Error ? error.message : 'Could not start scan session')
      setSessionState('setup')
    }
  }

  const leaveSession = () => {
    clearReleaseTimer()
    releaseScanner()
    setSessionState('setup')
    setCurrentScan(null)
    void syncQueuedWrites(true)
  }

  const handleRawScan = useCallback(
    async (raw: string) => {
      if (lockedRef.current || sessionState !== 'scanning') {
        return
      }

      lockedRef.current = true
      setLocked(true)
      void syncQueuedWrites(false)

      const scanId = crypto.randomUUID()
      let parsed
      try {
        parsed = parseQrPayload(raw)
      } catch (error) {
        rememberScan({
          id: scanId,
          raw,
          status: 'error',
          title: 'Erreur',
          message: error instanceof Error ? error.message : 'QR invalide',
          serviceDay,
          token: raw,
          ...(selectedTarget.kind === 'meal'
            ? {
                mealSessionKey: selectedMeal.key,
                mealSessionLabel: selectedMeal.label,
              }
            : {}),
        })
        scheduleRelease()
        return
      }

      const pendingScan: ScanEvent = {
        id: scanId,
        raw,
        status: 'ok',
        title: 'Vérification',
        message: 'Validation locale',
        serviceDay,
        token: parsed.token,
        ...(selectedTarget.kind === 'meal'
          ? {
              mealSessionKey: selectedMeal.key,
              mealSessionLabel: selectedMeal.label,
            }
          : {}),
      }

      setCurrentScan({ ...pendingScan, status: 'checking' })

      try {
        const validationSnapshot = hasNocoDbConfig() ? await refreshSnapshotForScan() : snapshot
        if (hasNocoDbConfig() && !validationSnapshot) {
          throw new Error('No local DB snapshot available')
        }

        const validation =
          hasNocoDbConfig() && validationSnapshot
            ? selectedTarget.kind === 'arrival'
              ? validateOfflineArrival(validationSnapshot, parsed, serviceDay)
              : validateOfflineScan(validationSnapshot, parsed, selectedMeal, serviceDay)
            : {
                result:
                  selectedTarget.kind === 'arrival'
                    ? validateOfflineArrival(snapshot ?? demoSnapshot(serviceDay), parsed, serviceDay).result
                    : await validateFoodPass(parsed, serviceDay, selectedMeal),
                snapshot: snapshot ?? demoSnapshot(serviceDay),
                pendingCount,
              }

        if (validation.snapshot) {
          setSnapshot(validation.snapshot)
        }
        setPendingCount(validation.pendingCount)
        rememberScan({
          ...validation.result,
          id: pendingScan.id,
          raw,
        })

        if (validation.result.status === 'ok' && 'vibrate' in navigator) {
          navigator.vibrate(80)
        }
      } catch (error) {
        rememberScan({
          id: pendingScan.id,
          raw,
          status: 'error',
          title: 'Erreur',
          message: error instanceof Error ? error.message : 'Validation failed',
          serviceDay,
          token: parsed.token,
          ...(selectedTarget.kind === 'meal'
            ? {
                mealSessionKey: selectedMeal.key,
                mealSessionLabel: selectedMeal.label,
              }
            : {}),
        })
      } finally {
        scheduleRelease()
      }
    },
    [
      pendingCount,
      rememberScan,
      refreshSnapshotForScan,
      scheduleRelease,
      selectedMeal,
      selectedTarget,
      serviceDay,
      sessionState,
      snapshot,
      syncQueuedWrites,
    ],
  )

  const scanner = useCapgoQrScanner({
    enabled: sessionState === 'scanning',
    onScan: handleRawScan,
    previewSelector: '.scanner-stage',
  })

  useEffect(() => {
    const syncTimer = window.setTimeout(() => {
      void syncQueuedWrites(false)
    }, 0)

    return () => window.clearTimeout(syncTimer)
  }, [syncQueuedWrites])

  useEffect(() => {
    if (network.remoteUsable && pendingCount > 0) {
      const retryTimer = window.setTimeout(() => {
        void syncQueuedWrites(false)
      }, 0)

      return () => window.clearTimeout(retryTimer)
    }
  }, [network.remoteUsable, pendingCount, syncQueuedWrites])

  useEffect(() => clearReleaseTimer, [clearReleaseTimer])

  const stats = useMemo(
    () =>
      recentScans.reduce<ScanStats>(
        (acc, scan) => ({
          ...acc,
          [scan.status]: acc[scan.status] + 1,
        }),
        { ...emptyStats },
      ),
    [recentScans],
  )

  const expectedMealCount = useMemo(
    () =>
      snapshot?.records.filter((record) =>
        selectedTarget.kind === 'arrival'
          ? Boolean(record.paymentDate)
          : record.paymentDate && record.entitlements[selectedMeal.key] === true,
      ).length ?? 0,
    [selectedMeal.key, selectedTarget.kind, snapshot],
  )

  const currentStatus = currentScan?.status ?? 'error'
  const CurrentIcon = currentScan ? statusIcon[currentStatus] : ScanLine
  const headerTitle = sessionState === 'scanning' ? selectedTarget.label : 'Festival Food Scan'
  const headerSubtitle = sessionState === 'scanning' ? 'Scan session active' : serviceDay
  const syncStatus = refreshingDb ? 'refreshing' : freshnessError ? 'stale' : pendingCount > 0 ? 'queued' : 'synced'
  const SyncIcon = syncing || refreshingDb ? RefreshCw : freshnessError ? TriangleAlert : pendingCount > 0 ? CloudUpload : CloudCheck
  const syncLabel = refreshingDb ? 'Checking DB' : syncing ? 'Syncing' : freshnessError ? 'Local DB' : pendingCount > 0 ? `${pendingCount} queued` : 'Synced'
  const syncAriaLabel = freshnessError ? `${syncLabel}: ${freshnessError}` : `Sync status: ${syncLabel}`

  return (
    <main className={`app-shell ${sessionState === 'scanning' ? 'scan-mode' : 'setup-mode'}`}>
      <header className="top-bar">
        {sessionState === 'scanning' && (
          <button className="icon-button header-back" type="button" onClick={leaveSession} aria-label="Leave scan session">
            <ArrowLeft size={17} aria-hidden="true" />
          </button>
        )}

        <div className="brand-lockup" aria-label="Festival Food Scan">
          {sessionState !== 'scanning' && (
            <span className="brand-mark">
              <Utensils size={18} aria-hidden="true" />
            </span>
          )}
          <div>
            <h1>{headerTitle}</h1>
            <p>{headerSubtitle}</p>
          </div>
        </div>

        <div className="top-actions">
          <span className={`mode-pill ${apiMode === 'NocoDB' ? 'live' : 'demo'}`}>{apiMode}</span>
          <span className={`status-pill sync ${syncStatus}`} aria-label={syncAriaLabel} title={freshnessError || syncLabel}>
            <SyncIcon size={15} aria-hidden="true" />
            {syncLabel}
          </span>
        </div>
      </header>

      {sessionState !== 'scanning' ? (
        <section className="setup-panel" aria-label="Start scan session">
          <div className="setup-heading">
            <DatabaseZap size={26} aria-hidden="true" />
            <div>
              <h2>Choisir le contrôle</h2>
              <p>{sessionMessage || 'Le choix reste verrouillé pendant la session de scan.'}</p>
            </div>
          </div>

          <div className="meal-picker" role="radiogroup" aria-label="Meal session">
            <section className="meal-day-group arrival-group" role="group" aria-labelledby="scan-target-arrival">
              <h3 className="meal-day-title" id="scan-target-arrival">
                Festival
              </h3>
              <div className="meal-grid single">
                <button
                  className={selectedTargetKind === 'arrival' ? 'selected' : ''}
                  type="button"
                  role="radio"
                  aria-checked={selectedTargetKind === 'arrival'}
                  onClick={() => setSelectedTargetKind('arrival')}
                  disabled={sessionState === 'loading'}
                >
                  Entrée festival
                </button>
              </div>
            </section>
            {mealSessionGroups.map((group) => (
              <section className="meal-day-group" role="group" aria-labelledby={`meal-day-${group.dayKey}`} key={group.dayKey}>
                <h3 className="meal-day-title" id={`meal-day-${group.dayKey}`}>
                  {group.dayLabel}
                </h3>
                <div className="meal-grid">
                  {group.sessions.map((session) => (
                    <button
                      className={selectedTargetKind === 'meal' && session.key === selectedMealKey ? 'selected' : ''}
                      type="button"
                      role="radio"
                      aria-checked={selectedTargetKind === 'meal' && session.key === selectedMealKey}
                      key={session.key}
                      onClick={() => {
                        setSelectedTargetKind('meal')
                        setSelectedMealKey(session.key)
                      }}
                      disabled={sessionState === 'loading'}
                    >
                      {session.mealLabel}
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>

          <div className="setup-actions">
            <button className="primary-action setup-start" type="button" onClick={startSession} disabled={sessionState === 'loading'}>
              {sessionState === 'loading' ? <Loader2 size={17} aria-hidden="true" /> : <ScanLine size={17} aria-hidden="true" />}
              Start scan
            </button>
            <button className="secondary-action" type="button" onClick={() => void syncQueuedWrites(true)}>
              <RefreshCw size={17} aria-hidden="true" />
              Sync DB
            </button>
          </div>

          <div className="setup-meta">
            <span>{snapshot ? `${snapshot.records.length} rows cached` : 'No cache yet'}</span>
            <span>{pendingCount} queued writes</span>
            <span>{syncMessage || 'Ready'}</span>
          </div>
        </section>
      ) : (
        <>
          <section className={`scanner-stage ${locked ? 'locked' : ''}`} aria-label="Scanner">
            <div id="camera-preview" aria-hidden="true" />
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
                <strong>{currentScan ? statusLabel[currentStatus] : scanner.active ? 'Prêt à scanner' : 'Caméra en cours'}</strong>
                <span>{currentScan?.personLabel ?? currentScan?.message ?? scanner.error ?? 'QR email dans le cadre'}</span>
              </div>
              <span className={`ready-badge ${locked ? 'hold' : 'ready'}`}>{locked ? 'Hold' : 'Ready'}</span>
            </div>

            <div className="stats-grid" aria-label="Session stats">
              <div>
                <strong>{stats.ok}</strong>
                <span>Validés</span>
              </div>
              <div>
                <strong>{expectedMealCount}</strong>
                <span>Attendus</span>
              </div>
              <div>
                <strong>{recentScans.length}</strong>
                <span>Scans</span>
              </div>
            </div>

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
        </>
      )}
    </main>
  )
}

export default App

function cacheModeMessage(network: NetworkDiagnosticsState): string {
  return network.remoteUsable ? 'Local cache used' : `${network.reason}, local cache used`
}

function demoSnapshot(serviceDay: string): ScanSessionSnapshot {
  return {
    serviceDay,
    downloadedAt: new Date().toISOString(),
    source: 'demo',
    records: [],
  }
}
