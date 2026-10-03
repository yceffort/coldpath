// Development only: stands in for src/report.rs, which writes the report JSON into the data slot.
import sample from './treemap.json?raw'

document.getElementById('report-data')!.textContent = sample
