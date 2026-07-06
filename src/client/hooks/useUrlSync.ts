import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'

const SESSION_PARAM = 'session'

function readSessionParam(): string | null {
  const value = new URLSearchParams(window.location.search).get(SESSION_PARAM)
  return value && value.length > 0 ? value : null
}

function buildUrl(sessionId: string | null): URL {
  const url = new URL(window.location.href)
  if (sessionId) {
    url.searchParams.set(SESSION_PARAM, sessionId)
  } else {
    url.searchParams.delete(SESSION_PARAM)
  }
  return url
}

/**
 * Two-way sync between the selected tmux window and the `?session=<id>` URL
 * query param, so window switches are bookmarkable/shareable and the browser
 * back/forward buttons step through previously-viewed windows.
 *
 * The state->URL writer only pushes a history entry when the new selection
 * differs from what the URL already shows. That no-ops the init and popstate
 * paths (the URL already matches), leaving only genuine user switches to push.
 */
export function useUrlSync(): void {
  // URL -> state on first load: a shared/bookmarked link wins over the
  // localStorage-persisted selection. With no param, reflect the persisted
  // selection into the URL via replaceState (no extra history entry), and
  // mirror back/forward navigation into the store via popstate.
  useEffect(() => {
    const { selectedSessionId, setSelectedSessionId } = useSessionStore.getState()
    const fromUrl = readSessionParam()
    if (fromUrl) {
      setSelectedSessionId(fromUrl)
    } else if (selectedSessionId) {
      window.history.replaceState(null, '', buildUrl(selectedSessionId))
    }

    const onPopState = () => {
      useSessionStore.getState().setSelectedSessionId(readSessionParam())
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  // state -> URL: push a history entry only when the selection actually differs
  // from what the URL already shows.
  useEffect(() => {
    return useSessionStore.subscribe((state, prev) => {
      if (state.selectedSessionId === prev.selectedSessionId) return
      if (state.selectedSessionId === readSessionParam()) return
      window.history.pushState(null, '', buildUrl(state.selectedSessionId))
    })
  }, [])
}
