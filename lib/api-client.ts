const NGROK_HEADER_NAME = "ngrok-skip-browser-warning"
const NGROK_HEADER_VALUE = "true"

function addNgrokHeader(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers)
  if (!headers.has(NGROK_HEADER_NAME)) {
    headers.set(NGROK_HEADER_NAME, NGROK_HEADER_VALUE)
  }
  return {
    ...init,
    headers,
  }
}

export function patchFetchWithNgrokHeader() {
  if (typeof window === "undefined") return
  const patchedKey = "__soltoolsFetchPatched"
  const win = window as typeof window & { [patchedKey]?: boolean }
  if (win[patchedKey]) return
  const original = window.fetch.bind(window)
  window.fetch = (input: RequestInfo, init?: RequestInit) => original(input, addNgrokHeader(init))
  win[patchedKey] = true
}
