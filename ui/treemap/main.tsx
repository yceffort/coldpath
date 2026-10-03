import './base.css'
import {createRoot} from 'react-dom/client'
import type {Report} from '../types.ts'
import {App} from './App.tsx'

if (import.meta.env.DEV) await import('../dev/treemap.ts')
const slot = document.getElementById('report-data')!
const report: Report = JSON.parse(slot.textContent!)
slot.textContent = ''
createRoot(document.getElementById('root')!).render(<App report={report} />)
