// Development only: stands in for src/report.rs, which replaces the placeholder with these payload elements.
import payloads from './report-payloads.html?raw'

for (const node of document.body.childNodes) if (node.nodeType === Node.TEXT_NODE) node.remove()
document.body.insertAdjacentHTML('beforeend', payloads)
