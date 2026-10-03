// StyleX props plus plain class names that the browser checks and DOM queries select by.
export function classes(names: string, props: {className?: string; style?: Readonly<Record<string, string | number>>}) {
  return {...props, className: [names, props.className].filter(Boolean).join(' ') || undefined}
}
