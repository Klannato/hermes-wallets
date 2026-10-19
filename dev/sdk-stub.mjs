/**
 * Minimal stand-in for `@hermes/plugin-sdk` so the pane module can be rendered
 * outside the desktop app. Only the surface the plugin imports is provided.
 */

let queryData = null

export const cn = (...args) => args.filter(Boolean).join(' ')
export const haptic = () => {}
export const host = {
  state: { focusedSessionId: { get: () => null } },
  notify: () => {}
}
export const useValue = (atom) => (atom && typeof atom.get === 'function' ? atom.get() : null)
export const useQuery = () => ({
  data: queryData,
  error: null,
  isFetching: false,
  refetch: () => Promise.resolve()
})
export function __setQueryData(next) {
  queryData = next
}
