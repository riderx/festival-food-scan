import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left.mjs'
import CheckCircle2 from 'lucide-react/dist/esm/icons/check-circle-2.mjs'
import CircleDollarSign from 'lucide-react/dist/esm/icons/circle-dollar-sign.mjs'
import CloudCheck from 'lucide-react/dist/esm/icons/cloud-check.mjs'
import CloudUpload from 'lucide-react/dist/esm/icons/cloud-upload.mjs'
import DatabaseZap from 'lucide-react/dist/esm/icons/database-zap.mjs'
import Loader2 from 'lucide-react/dist/esm/icons/loader-2.mjs'
import Mail from 'lucide-react/dist/esm/icons/mail.mjs'
import QrCode from 'lucide-react/dist/esm/icons/qr-code.mjs'
import RefreshCw from 'lucide-react/dist/esm/icons/refresh-cw.mjs'
import ScanLine from 'lucide-react/dist/esm/icons/scan-line.mjs'
import ShieldX from 'lucide-react/dist/esm/icons/shield-x.mjs'
import TriangleAlert from 'lucide-react/dist/esm/icons/triangle-alert.mjs'
import Utensils from 'lucide-react/dist/esm/icons/utensils.mjs'
import UserPlus from 'lucide-react/dist/esm/icons/user-plus.mjs'
import X from 'lucide-react/dist/esm/icons/x.mjs'
import { toSvg } from 'better-qr'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'
import { parseQrPayload, serviceDayFor, validateFoodPass } from './domain/mealPass'
import type { FoodPassResult, FoodPassStatus, QrPayload } from './domain/mealPass'
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
import { playScanSuccessFeedback, preloadScanFeedback } from './hooks/useScanFeedback'

type ScanEvent = FoodPassResult & {
  id: string
  raw: string
}

type CurrentScan = Omit<ScanEvent, 'status'> & {
  status: FoodPassStatus | 'checking'
}

type SessionState = 'setup' | 'loading' | 'scanning'
type ScanTargetKind = 'arrival' | 'meal'

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
  const [qrMakerOpen, setQrMakerOpen] = useState(false)
  const [qrEmail, setQrEmail] = useState('')
  const [manualOpen, setManualOpen] = useState(false)
  const [manualEmail, setManualEmail] = useState('')
  const [manualScan, setManualScan] = useState<CurrentScan | null>(null)
  const [manualChecking, setManualChecking] = useState(false)
  const lockedRef = useRef(false)
  const releaseTimerRef = useRef<number | undefined>(undefined)
  const syncInFlightRef = useRef(false)
  const network = useNetworkDiagnostics()
  const refreshNetwork = network.refresh

  const rememberScan = useCallback((scan: ScanEvent) => {
    setCurrentScan(scan)
    setRecentScans((items) => [scan, ...items].slice(0, 10))
  }, [])

  const selectedTargetScanFields = useMemo(
    () =>
      selectedTarget.kind === 'meal'
        ? {
            mealSessionKey: selectedMeal.key,
            mealSessionLabel: selectedMeal.label,
          }
        : {},
    [selectedMeal.key, selectedMeal.label, selectedTarget.kind],
  )

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

  const validateParsedScan = useCallback(
    async (raw: string, parsed: QrPayload, scanId: string): Promise<ScanEvent> => {
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

      const finalScan = {
        ...validation.result,
        id: scanId,
        raw,
      }

      if (validation.result.status === 'ok') {
        playScanSuccessFeedback()
      }

      return finalScan
    },
    [pendingCount, refreshSnapshotForScan, selectedMeal, selectedTarget.kind, serviceDay, snapshot],
  )

  const validateRawValue = useCallback(
    async (raw: string, scanId: string, onChecking?: (scan: CurrentScan) => void): Promise<ScanEvent> => {
      void syncQueuedWrites(false)

      let parsed: QrPayload
      try {
        parsed = parseQrPayload(raw)
      } catch (error) {
        return {
          id: scanId,
          raw,
          status: 'error',
          title: 'Erreur',
          message: error instanceof Error ? error.message : 'QR invalide',
          serviceDay,
          token: raw,
          ...selectedTargetScanFields,
        }
      }

      const pendingScan: ScanEvent = {
        id: scanId,
        raw,
        status: 'ok',
        title: 'Vérification',
        message: 'Validation locale',
        serviceDay,
        token: parsed.token,
        ...selectedTargetScanFields,
      }

      onChecking?.({ ...pendingScan, status: 'checking' })

      try {
        return await validateParsedScan(raw, parsed, scanId)
      } catch (error) {
        return {
          id: pendingScan.id,
          raw,
          status: 'error',
          title: 'Erreur',
          message: error instanceof Error ? error.message : 'Validation failed',
          serviceDay,
          token: parsed.token,
          ...selectedTargetScanFields,
        }
      }
    },
    [selectedTargetScanFields, serviceDay, syncQueuedWrites, validateParsedScan],
  )

  const handleRawScan = useCallback(
    async (raw: string) => {
      if (lockedRef.current || sessionState !== 'scanning') {
        return
      }

      lockedRef.current = true
      setLocked(true)
      const scanId = crypto.randomUUID()
      try {
        const finalScan = await validateRawValue(raw, scanId, setCurrentScan)
        rememberScan(finalScan)
      } finally {
        scheduleRelease()
      }
    },
    [rememberScan, scheduleRelease, sessionState, validateRawValue],
  )

  const submitManualEmail = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (manualChecking) {
        return
      }

      const raw = manualEmail.trim()
      if (!raw) {
        return
      }

      const scanId = crypto.randomUUID()
      setManualChecking(true)
      try {
        const finalScan = await validateRawValue(raw, scanId, setManualScan)
        setManualScan(finalScan)
        rememberScan(finalScan)
      } finally {
        setManualChecking(false)
      }
    },
    [manualChecking, manualEmail, rememberScan, validateRawValue],
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

  useEffect(() => {
    preloadScanFeedback()
  }, [])

  useEffect(() => {
    if (!qrMakerOpen && !manualOpen) {
      return
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setQrMakerOpen(false)
        setManualOpen(false)
      }
    }

    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [manualOpen, qrMakerOpen])

  const expectedMealCount = useMemo(
    () =>
      snapshot?.records.filter((record) =>
        selectedTarget.kind === 'arrival'
          ? Boolean(record.paymentDate)
          : record.paymentDate && record.entitlements[selectedMeal.key] === true,
      ).length ?? 0,
    [selectedMeal.key, selectedTarget.kind, snapshot],
  )
  const validatedCount = useMemo(
    () =>
      snapshot?.records.filter((record) =>
        selectedTarget.kind === 'arrival'
          ? Boolean(record.paymentDate && record.arrived)
          : Boolean(record.paymentDate && record.entitlements[selectedMeal.key] === true && record.scannedAt[selectedMeal.key]),
      ).length ?? 0,
    [selectedMeal.key, selectedTarget.kind, snapshot],
  )
  const normalizedQrEmail = useMemo(() => normalizeQrEmail(qrEmail), [qrEmail])
  const qrEmailHasValue = qrEmail.trim().length > 0
  const qrEmailIsValid = !qrEmailHasValue || Boolean(normalizedQrEmail)
  const guestQrDataUrl = useMemo(() => {
    if (!normalizedQrEmail) {
      return ''
    }

    const svg = toSvg(normalizedQrEmail, {
      errorCorrectionLevel: 'M',
      margin: 2,
      moduleSize: 8,
      foreground: '#0f172a',
      background: '#ffffff',
      title: 'Guest QR',
    })
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`
  }, [normalizedQrEmail])

  const currentStatus = currentScan?.status ?? 'error'
  const CurrentIcon = currentScan ? statusIcon[currentStatus] : ScanLine
  const currentDetail = currentScan
    ? scanDetailText(currentScan)
    : scannerErrorText(scanner.error) ?? 'QR email dans le cadre'
  const manualStatus = manualScan?.status ?? 'checking'
  const ManualIcon = manualScan ? statusIcon[manualStatus] : UserPlus
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
            <button
              className="secondary-action manual-action"
              type="button"
              onClick={() => {
                setManualOpen(true)
                setManualScan(null)
              }}
            >
              <UserPlus size={17} aria-hidden="true" />
              Ajout manuel
            </button>
            <button className="secondary-action qr-action" type="button" onClick={() => setQrMakerOpen(true)}>
              <QrCode size={17} aria-hidden="true" />
              QR invité
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
                <span>{currentDetail}</span>
              </div>
              <span className={`ready-badge ${locked ? 'hold' : 'ready'}`}>{locked ? 'Hold' : 'Ready'}</span>
            </div>

            <div className="stats-grid" aria-label="Session stats">
              <div>
                <strong>{validatedCount}</strong>
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
                    <strong>{recentScanText(scan)}</strong>
                  </div>
                ))}
              </div>
            )}
          </aside>
        </>
      )}

      {manualOpen && (
        <div className="qr-modal-backdrop" role="presentation" onMouseDown={() => setManualOpen(false)}>
          <section
            className="qr-modal manual-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="manual-add-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="qr-modal-header">
              <div>
                <h2 id="manual-add-title">Ajout manuel</h2>
                <p>{selectedTarget.label}</p>
              </div>
              <button className="icon-button" type="button" onClick={() => setManualOpen(false)} aria-label="Fermer">
                <X size={17} aria-hidden="true" />
              </button>
            </div>

            <form className="manual-form" onSubmit={submitManualEmail}>
              <label className="qr-input-label" htmlFor="manual-add-email">
                Email
              </label>
              <div className="qr-input-row">
                <Mail size={17} aria-hidden="true" />
                <input
                  id="manual-add-email"
                  type="email"
                  inputMode="email"
                  autoCapitalize="none"
                  autoComplete="email"
                  spellCheck={false}
                  placeholder="email@exemple.com"
                  value={manualEmail}
                  onChange={(event) => setManualEmail(event.target.value)}
                />
              </div>

              <button
                className={`primary-action manual-submit ${manualChecking ? 'loading' : ''}`}
                type="submit"
                disabled={manualChecking || !manualEmail.trim()}
              >
                {manualChecking ? <Loader2 size={17} aria-hidden="true" /> : <UserPlus size={17} aria-hidden="true" />}
                Valider
              </button>
            </form>

            <div className={`result-strip manual-result ${manualScan ? manualStatus : 'idle'}`} aria-live="polite">
              <span className="result-icon">
                <ManualIcon size={22} aria-hidden="true" />
              </span>
              <div className="result-copy">
                <strong>{manualScan ? statusLabel[manualStatus] : 'Prêt'}</strong>
                <span>{manualScan ? scanDetailText(manualScan) : `Contrôle ${selectedTarget.label}`}</span>
              </div>
            </div>
          </section>
        </div>
      )}

      {qrMakerOpen && (
        <div className="qr-modal-backdrop" role="presentation" onMouseDown={() => setQrMakerOpen(false)}>
          <section
            className="qr-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="qr-maker-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="qr-modal-header">
              <div>
                <h2 id="qr-maker-title">QR invité</h2>
                <p>{normalizedQrEmail || 'Email invité'}</p>
              </div>
              <button className="icon-button" type="button" onClick={() => setQrMakerOpen(false)} aria-label="Fermer">
                <X size={17} aria-hidden="true" />
              </button>
            </div>

            <label className="qr-input-label" htmlFor="guest-qr-email">
              Email
            </label>
            <div className="qr-input-row">
              <Mail size={17} aria-hidden="true" />
              <input
                id="guest-qr-email"
                type="email"
                inputMode="email"
                autoCapitalize="none"
                autoComplete="email"
                spellCheck={false}
                placeholder="email@exemple.com"
                value={qrEmail}
                onChange={(event) => setQrEmail(event.target.value)}
              />
            </div>
            {qrEmailHasValue && !qrEmailIsValid && <p className="qr-error">Email invalide</p>}

            <div className={`qr-preview ${guestQrDataUrl ? 'ready' : ''}`} aria-live="polite">
              {guestQrDataUrl ? (
                <img src={guestQrDataUrl} alt={`QR ${normalizedQrEmail}`} />
              ) : (
                <QrCode size={76} aria-hidden="true" />
              )}
            </div>
          </section>
        </div>
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

function normalizeQrEmail(value: string): string {
  const email = value.trim().toLowerCase()
  return email.includes('@') && email.includes('.') ? email : ''
}

function scanDetailText(scan: CurrentScan): string {
  if (scan.status === 'ok' || scan.status === 'checking') {
    return scan.personLabel ?? scan.message ?? scan.token
  }

  return scan.message || scan.personLabel || scan.token
}

function recentScanText(scan: ScanEvent): string {
  if (scan.status === 'ok') {
    return scan.personLabel ?? scan.token
  }

  return scan.message || scan.personLabel || scan.token
}

function scannerErrorText(error: string | null): string | null {
  return error || null
}
