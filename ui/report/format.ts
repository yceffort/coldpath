export const number = (n: number) => n.toLocaleString('en-US')
export const basename = (path: string) => path.split('/').pop() || path
export const sizeParts = (bytes: number): [string, string] => {
  const unit = bytes >= 1e6 ? 'MB' : bytes >= 1e3 ? 'KB' : 'B'
  const value = bytes / (unit === 'MB' ? 1e6 : unit === 'KB' ? 1e3 : 1)
  return [value.toLocaleString('en-US', {maximumFractionDigits: unit === 'B' ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2}), unit]
}
export const size = (bytes: number) => sizeParts(bytes).join(' ')
export const labels = {observed: 'Observed', unobserved: 'Unobserved', unmeasured: 'Unmeasured'}
export const rejectedCount = (n: number) => number(n) + ' rejected mapping' + (n === 1 ? '' : 's')
