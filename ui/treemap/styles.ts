import * as stylex from '@stylexjs/stylex'

// Styles shared by several treemap components.
export const shared = stylex.create({
  panel: {
    backgroundColor: 'var(--panel)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--border)',
    borderRadius: 12,
    padding: {default: 22, '@media (max-width: 650px)': 14},
    marginTop: 24,
    minWidth: 0,
  },
  note: {fontSize: 13, color: 'var(--muted)'},
  // A color square in legends, chips, and facts.
  swatch: {
    display: 'inline-block',
    width: 12,
    height: 12,
    borderRadius: 3,
    boxShadow: 'inset 0 0 0 1px var(--edge)',
    flex: 'none',
  },
  toolbar: {display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center'},
  link: {
    borderWidth: 0,
    padding: 0,
    backgroundColor: 'transparent',
    color: 'var(--accent)',
    textDecoration: 'underline',
    textUnderlineOffset: 3,
  },
})
