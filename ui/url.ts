// Adds or replaces a history entry whose URL carries `hash`, which is '' when the view needs none. A document that may not
// rewrite its URL, such as a frame that another page fills from a string, gets the entry under the URL it has.
export function writeHistory(method: 'pushState' | 'replaceState', state: unknown, hash: string) {
  const url = new URL(location.href)
  url.hash = hash
  try {
    history[method](state, '', url)
  } catch {
    history[method](state, '')
  }
}
