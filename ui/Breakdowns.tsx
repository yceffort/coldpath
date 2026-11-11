import * as stylex from '@stylexjs/stylex'
import type {Change, InitialLoad, InitialLoadChange, Report} from './types.ts'

const number = (value: number) => value.toLocaleString('en-US')
const signed = (value: number) => (value > 0 ? '+' : '') + number(value)

// The comparison of each document, or null when it has none. As in the analyzer, one document on each side is compared
// whatever its path; with several, only with the baseline's document of the same path.
function compared(pages: InitialLoad[], change: InitialLoadChange) {
  return pages.map((page) =>
    change.pages?.length ? (change.pages.find((p) => p.html === page.html) ?? null) : pages.length === 1 ? change : null,
  )
}

export function InitialLoads({report}: {report: Report}) {
  const load = report.initialLoad
  if (!load) return null
  const pages = load.pages?.length ? load.pages : [load]
  const change = report.baseline?.initialLoad
  const changes = change && compared(pages, change)
  return (
    <section id="initial-load" {...stylex.props(styles.box)}>
      <h2 {...stylex.props(styles.title)}>Initial load</h2>
      <p {...stylex.props(styles.note)}>
        The selected bundles each --initial-html document names, found without a browser: what it loads before any interaction.
      </p>
      <div {...stylex.props(styles.scroll)}>
        <table {...stylex.props(styles.table)}>
          <thead>
            <tr>
              {['Document', 'Bytes', 'Bundles', ...(changes ? ['Change from baseline'] : [])].map((name, i) => (
                <th key={name} {...stylex.props(styles.cell, styles.th, (!i || name.startsWith('Change')) && styles.text)}>
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pages.map((page, index) => {
              const row = changes?.[index]
              return (
                <tr key={index}>
                  <td {...stylex.props(styles.cell, styles.text, styles.name)}>{page.html}</td>
                  <td {...stylex.props(styles.cell)}>{number(page.bytes)}</td>
                  <td {...stylex.props(styles.cell)}>{page.bundles.length}</td>
                  {changes && (
                    <td {...stylex.props(styles.cell, styles.text, styles.name)}>
                      {row ? (
                        <>
                          {signed(row.deltaBytes) + ' B (' + number(row.beforeBytes) + ' B to ' + number(row.afterBytes) + ' B)'}
                          {row.addedBundles.length > 0 && <div>{'Added: ' + row.addedBundles.join(', ')}</div>}
                          {row.removedBundles.length > 0 && <div>{'Removed: ' + row.removedBundles.join(', ')}</div>}
                        </>
                      ) : (
                        'Not compared'
                      )}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// Sources aggregated by --group-by, with the baseline's sources grouped by the same patterns.
export function Groups({report}: {report: Report}) {
  const groups = report.groups || []
  const changes = report.baseline?.groups
  const removed = changes?.filter((row) => row.change === 'removed') || []
  if (!groups.length && !removed.length) return null
  const delta = (row?: Change) =>
    row ? signed(row.delta.bytes) + ' / ' + signed(row.delta.unobservedBytes) + (row.change === 'added' ? ' (new)' : '') : '—'
  return (
    <section id="groups" {...stylex.props(styles.box)}>
      <h2 {...stylex.props(styles.title)}>Groups</h2>
      <div {...stylex.props(styles.scroll)}>
        <table {...stylex.props(styles.table)}>
          <thead>
            <tr>
              {['Group', 'Sources', 'Bytes', 'Observed', 'Unobserved', 'Unmeasured', ...(changes ? ['Δ bytes / unobserved'] : [])].map(
                (name, i) => (
                  <th key={name} {...stylex.props(styles.cell, styles.th, !i && styles.text)}>
                    {name}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {groups.map((row) => (
              <tr key={row.group}>
                <td title={row.pattern} {...stylex.props(styles.cell, styles.text, styles.name)}>
                  {row.group}
                </td>
                {[row.sources, row.bytes, row.observedBytes, row.unobservedBytes, row.unmeasuredBytes].map((value, i) => (
                  <td key={i} {...stylex.props(styles.cell)}>
                    {number(value)}
                  </td>
                ))}
                {changes && <td {...stylex.props(styles.cell)}>{delta(changes.find((c) => c.name === row.group))}</td>}
              </tr>
            ))}
            {removed.map((row) => (
              <tr key={row.name}>
                <td {...stylex.props(styles.cell, styles.text, styles.name)}>{row.name}</td>
                <td colSpan={5} {...stylex.props(styles.cell, styles.text)}>
                  Not in this report
                </td>
                <td {...stylex.props(styles.cell)}>{signed(row.delta.bytes) + ' / ' + signed(row.delta.unobservedBytes) + ' (removed)'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

const styles = stylex.create({
  box: {
    marginTop: 20,
    paddingBlock: 14,
    paddingInline: 16,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--border)',
    borderRadius: 10,
    backgroundColor: 'var(--panel)',
    minWidth: 0,
  },
  title: {fontSize: 15, marginBlock: 0},
  note: {marginTop: 4, marginBottom: 0, fontSize: 12, color: 'var(--muted)'},
  scroll: {overflow: 'auto', maxHeight: 360, marginTop: 8},
  table: {borderCollapse: 'collapse', width: '100%', fontSize: 13, fontVariantNumeric: 'tabular-nums'},
  cell: {
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: 'var(--border)',
    paddingBlock: 6,
    paddingInline: 10,
    textAlign: 'right',
    whiteSpace: 'nowrap',
    verticalAlign: 'top',
  },
  th: {color: 'var(--muted)', fontWeight: 500},
  text: {textAlign: 'left'},
  name: {whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 160},
})
