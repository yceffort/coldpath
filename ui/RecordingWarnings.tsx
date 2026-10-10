import * as stylex from '@stylexjs/stylex'

// What the collector reported about the recorded page state, shown above the numbers it qualifies.
export function RecordingWarnings({warnings}: {warnings?: string[]}) {
  if (!warnings?.length) return null
  return (
    <section id="recording-warnings" role="note" {...stylex.props(styles.box)}>
      <strong>The collector reported page state problems or left scripts out. These numbers describe the page as it was recorded.</strong>
      <ul {...stylex.props(styles.list)}>
        {warnings.map((warning, index) => (
          <li key={index}>{warning}</li>
        ))}
      </ul>
    </section>
  )
}

const styles = stylex.create({
  box: {
    marginTop: 20,
    paddingBlock: 12,
    paddingInline: 16,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--border)',
    borderInlineStartWidth: 4,
    borderInlineStartColor: 'var(--warning)',
    borderRadius: 8,
    backgroundColor: 'var(--panel)',
    fontSize: 13,
    overflowWrap: 'anywhere',
  },
  list: {marginTop: 6, marginBottom: 0, paddingInlineStart: 18},
})
