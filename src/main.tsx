import { StrictMode } from 'react'
import { CapacitorUpdater } from '@capgo/capacitor-updater'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

void CapacitorUpdater.notifyAppReady().catch(() => undefined)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
