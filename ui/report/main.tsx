import './base.css'
import {createRoot} from 'react-dom/client'
import type {Report} from '../types.ts'
import {App, Pending} from './App.tsx'
import {decodeData} from './data.ts'

if (import.meta.env.DEV) await import('../dev/report.ts')
const root = createRoot(document.getElementById('root')!)
root.render(<Pending meta="Loading report…" />)
try {
  const report = await decodeData<Report>('report-data')
  document.getElementById('report-data')!.textContent = ''
  root.render(<App report={report} />)
  performance.mark('coldpath:overview')
} catch (error) {
  root.render(<Pending meta={'Could not open the report: ' + (error as Error).message} />)
}
