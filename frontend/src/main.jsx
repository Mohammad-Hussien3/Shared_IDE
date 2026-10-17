import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { installSparkTokens } from './lib/sparkTheme'
import { initMonitoring } from './lib/monitoring'
import MonitoringBoundary from './components/MonitoringBoundary'

initMonitoring()
installSparkTokens()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <MonitoringBoundary><App /></MonitoringBoundary>
  </StrictMode>,
)
