import * as stylex from '@stylexjs/stylex'
import type {ReactNode} from 'react'
import {classes} from '../classes.ts'
import type {Report} from '../types.ts'
import {actionLabels, loadText, milliseconds, number, phaseColor, size} from './format.ts'
import type {TreeNode, View} from './model.ts'
import {shared} from './styles.ts'

interface Props {
  report: Report
  node: TreeNode
  view: View
  scenario: string
  initial: string
}

// Everything known about one source. The treemap keeps it until another source is selected, so the inspector frame keeps its state.
export function FileDetails({report, node, view, scenario, initial}: Props) {
  const facts: ReactNode[] = []
  const fact = (label: string, value: string, color?: string) =>
    facts.push(
      <div key={facts.length} {...stylex.props(styles.fact)}>
        <dt {...stylex.props(styles.term)}>
          {color && <i style={{background: color}} {...stylex.props(shared.swatch)} />}
          {label}
        </dt>
        <dd {...stylex.props(styles.value)}>{value}</dd>
      </div>,
    )
  fact('Generated size', number(view.bytes) + ' B')
  fact('Package', node.package!)
  for (const phase of node.firstObserved!)
    fact(
      'First ran in ' + phase.scenario + (phase.earlierUnmeasured ? ' (earlier unmeasured)' : ''),
      number(phase.bytes) + ' B',
      phase.earlierUnmeasured ? 'var(--unknown-initial)' : phaseColor(report.scenarios.indexOf(phase.scenario)),
    )
  if (initial) {
    fact('Ran initially', number(view.initialObserved) + ' B', 'var(--observed)')
    fact('Interaction only', number(view.interactionOnly) + ' B', 'var(--interaction)')
    fact('Ran later, initial unmeasured', number(view.initialUnknown) + ' B', 'var(--unknown-initial)')
  }
  fact('Never ran', number(view.unobservedBytes) + ' B', 'var(--unobserved)')
  let bundleNode: TreeNode | null = node
  while (bundleNode && bundleNode.kind !== 'bundle') bundleNode = bundleNode.parent
  if (bundleNode?.loading) fact('Bundle loaded', loadText(bundleNode.loading))

  const note = (text: string) => <p {...stylex.props(shared.note)}>{text}</p>
  const codes = (list: string[]) =>
    list.flatMap((text, i) => [
      ...(i ? [' '] : []),
      <code key={i} {...stylex.props(styles.evidence)}>
        {text}
      </code>,
    ])
  const label = node.label
  const generator = report.labelGenerator
  const by = generator ? ' by ' + [generator.provider, generator.model].filter(Boolean).join(' ') : ''
  const actions = report.recommendations.filter((row) => row.source === node.source)
  const graph = report.importPaths?.find((row) => row.resolvedSource === node.source)

  return (
    <>
      <code {...classes('file-path', stylex.props(styles.path))}>{node.source}</code>
      <dl {...classes('facts', stylex.props(styles.facts))}>{facts}</dl>
      {label && (
        <>
          <h3 {...stylex.props(styles.heading)}>What it is</h3>
          {label.summary && <p>{label.summary}</p>}
          {label.name && (
            <div {...stylex.props(styles.callout, styles.inferred)}>
              <strong>{'Inferred identity: ' + label.name + (label.kind ? ' (' + label.kind + ')' : '')}</strong>
              {label.reasoning && <p {...stylex.props(styles.calloutText)}>{label.reasoning}</p>}
              {label.evidence?.length ? (
                <p {...stylex.props(styles.calloutText)}>Evidence found in this source: {codes(label.evidence)}</p>
              ) : null}
            </div>
          )}
          {label.contents?.length ? (
            <div {...stylex.props(styles.callout, styles.inferred)}>
              <strong>Inferred contents of this chunk</strong>
              {label.reasoning && <p {...stylex.props(styles.calloutText)}>{label.reasoning}</p>}
              <ul>
                {label.contents.map((part, i) => (
                  <li key={i}>
                    <strong>{part.name + (part.kind ? ' (' + part.kind + ')' : '')}</strong>: {codes(part.evidence)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {note('Generated' + by + '. A language model guessed this from the code; it is not source-map evidence and can be wrong.')}
        </>
      )}
      {node.estimatedCompression &&
        note(
          'Estimated isolated source size: gzip ' +
            size(node.estimatedCompression.gzipBytes) +
            ', Brotli ' +
            size(node.estimatedCompression.brotliBytes) +
            '. Attributed fragments compressed in isolation; not measured transfer savings.',
        )}
      {actions.length > 0 && <h3 {...stylex.props(styles.heading)}>What to review</h3>}
      {actions.map((action, i) => (
        <div key={i} {...stylex.props(styles.callout)}>
          <strong>{actionLabels[action.kind] + (action.scenario ? ' in ' + action.scenario : '')}</strong>
          <p {...stylex.props(styles.calloutText)}>{action.explanation}</p>
        </div>
      ))}
      {report.scenarioReports.map((row) => {
        const candidate = row.interactionCandidates.find((candidate) => candidate.source === node.source)
        return candidate?.estimatedDeferrableCompression
          ? note(
              row.scenario +
                ' deferral estimate: gzip ' +
                size(candidate.estimatedDeferrableCompression.gzipBytes) +
                ', ' +
                number(candidate.interactionOnlyBytes) +
                ' raw B across all bundles. Estimate requires rebuild verification.',
            )
          : null
      })}
      {report.initialScenario && note('Estimates and review actions compare with recorded initial scenario: ' + report.initialScenario)}
      <Cpu report={report} source={node.source!} />
      <h3 {...stylex.props(styles.heading)}>Why it is in the bundle</h3>
      <p>
        {graph?.path
          ? 'Import path: ' + graph.path.join(' → ') + ' (' + graph.graphFormat + ' graph)'
          : 'Import path unavailable for this source. Pass --graph to see the import chain.'}
      </p>
      {graph?.edges?.length ? (
        <ol {...stylex.props(styles.chain)}>
          {graph.edges.map((edge, i) => (
            <li key={i} {...stylex.props(styles.step)}>
              <code>{edge.from + (edge.location ? ':' + edge.location.line + ':' + edge.location.column : '')}</code>
              {' ' + edge.kind + ' imports '}
              <code>{edge.to}</code>
              {edge.location ? '' : ' (location unavailable)'}
            </li>
          ))}
        </ol>
      ) : null}
      <h3 {...stylex.props(styles.heading)}>Code</h3>
      {report.inspectorHtml ? (
        <>
          <p>Choose a scenario in the inspector to see its executed and unexecuted ranges.</p>
          <iframe
            id="code-frame"
            title="Source code inspector"
            sandbox="allow-scripts"
            name={'coldpath:' + JSON.stringify({bundle: node.bundleIndex, source: node.sourceIndex, scenario})}
            srcDoc={report.inspectorHtml}
            {...stylex.props(styles.frame)}
          />
        </>
      ) : (
        <p>Generate with --details to include the code inspector.</p>
      )}
    </>
  )
}

// Self time per scenario window. A profiled bundle with this source and no row means its functions were not sampled.
function Cpu({report, source}: {report: Report; source: string}) {
  if (!report.cpu) return null
  const holders = report.bundles.filter((bundle) => bundle.sources.some((s) => s.source === source)).map((bundle) => bundle.path)
  const samples = (count: number) => number(count) + (count === 1 ? ' sample' : ' samples')
  const facts: ReactNode[] = []
  const fact = (term: string, value: string, detail: string) =>
    facts.push(
      <div key={facts.length} {...stylex.props(styles.fact)}>
        <dt {...stylex.props(styles.term)}>{term}</dt>
        <dd {...stylex.props(styles.value)}>{value}</dd>
        <small>{detail}</small>
      </div>,
    )
  for (const scenario of report.cpu.scenarios) {
    const profiled = holders.filter((path) => scenario.bundles.includes(path))
    const runs = ' in ' + scenario.runs + ' runs'
    for (const window of scenario.windows) {
      const label = scenario.scenario + ', ' + window.window + ' window'
      const row = window.sources.find((s) => s.source === source)
      // An insufficient value is never the headline, so it cannot read as a low cost.
      if (row?.status === 'measured')
        fact(
          label,
          milliseconds(row.medianUs),
          'Q1 to Q3: ' + milliseconds(row.q1Us) + ' to ' + milliseconds(row.q3Us) + ', ' + samples(row.medianSamples) + ' per run' + runs,
        )
      else if (row)
        fact(label, 'Insufficient samples', 'median ' + milliseconds(row.medianUs) + ', ' + samples(row.medianSamples) + ' per run' + runs)
      else if (profiled.length) fact(label, 'No function samples', '0 samples' + runs)
      // Module-level code in a scope-hoisted bundle runs in the bundle's top level, which no source owns.
      for (const top of window.topLevel.filter((top) => top.status === 'measured' && profiled.includes(top.path)))
        fact(
          label + ', top level of ' + top.path,
          milliseconds(top.medianUs),
          'code no single source owns, such as module evaluation in a scope-hoisted bundle; ' +
            samples(top.medianSamples) +
            ' per run' +
            runs,
        )
    }
  }
  if (!facts.length) return null
  return (
    <>
      <h3 {...stylex.props(styles.heading)}>CPU self time</h3>
      <dl {...classes('facts', stylex.props(styles.facts))}>{facts}</dl>
      <p {...stylex.props(shared.note)}>
        {"Self time of this source's functions: median and quartiles over runs, adding up every bundle with this source. Below " +
          report.cpu.minSamples +
          " samples per run a value is insufficient: it is unreliable, and no samples does not mean cheap. Code a minifier inlined counts toward the function it was inlined into; module-level code counts toward its bundle's top level, or toward [unmapped] in a bundle that wraps each module in a function, such as webpack."}
      </p>
    </>
  )
}

const styles = stylex.create({
  heading: {fontSize: 13, color: 'var(--muted)', fontWeight: 600, marginTop: 22, marginBottom: 8, marginInline: 0},
  path: {display: 'block', color: 'var(--muted)', marginTop: 2, marginBottom: 12, marginInline: 0},
  facts: {display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10, margin: 0},
  fact: {paddingBlock: 10, paddingInline: 12, borderRadius: 8, backgroundColor: 'var(--raised)'},
  term: {fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6},
  value: {marginTop: 2, marginBottom: 0, marginInline: 0, fontWeight: 650, fontVariantNumeric: 'tabular-nums'},
  callout: {
    borderLeftWidth: 4,
    borderLeftStyle: 'solid',
    borderLeftColor: 'var(--ran)',
    backgroundColor: 'var(--raised)',
    borderTopLeftRadius: 0,
    borderTopRightRadius: 8,
    borderBottomRightRadius: 8,
    borderBottomLeftRadius: 0,
    paddingBlock: 10,
    paddingInline: 14,
    marginBlock: 8,
    marginInline: 0,
  },
  // AI-inferred identity: dashed to set it apart from measured evidence.
  inferred: {borderLeftStyle: 'dashed', borderLeftColor: 'var(--muted)'},
  calloutText: {marginTop: 2, marginBottom: 0, marginInline: 0},
  evidence: {wordBreak: 'break-all'},
  chain: {margin: 0, paddingLeft: 22},
  step: {paddingBlock: 3, paddingInline: 0, '::marker': {color: 'var(--muted)', fontSize: 12}},
  frame: {width: '100%', height: 900, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--border)', borderRadius: 10, marginTop: 8},
})
