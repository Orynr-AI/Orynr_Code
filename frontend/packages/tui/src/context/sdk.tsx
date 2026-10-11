import { createOrynrClient } from "@orynr-ai/sdk/v2"
import type { GlobalEvent } from "@orynr-ai/sdk/v2"
import { Flag } from "@orynr-ai/core/flag/flag"
import { createSimpleContext } from "./helper"
import { batch, onCleanup, onMount } from "solid-js"

export type EventSource = {
  subscribe: (handler: (event: GlobalEvent) => void) => Promise<() => void>
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
  }) => {
    const abort = new AbortController()
    let sse: AbortController | undefined

    // The active project directory. Sent as ?directory= on every v2 call, so changing it re-roots
    // the whole engine (sessions/LSP/MCP/tools) for subsequent requests — see setDirectory().
    let currentDirectory = props.directory

    function createSDK() {
      return createOrynrClient({
        baseUrl: props.url,
        signal: abort.signal,
        directory: currentDirectory,
        fetch: props.fetch,
        headers: props.headers,
      })
    }

    let sdk = createSDK()

    const handlers = new Set<(event: GlobalEvent) => void>()
    const emitter = {
      emit(_type: "event", event: GlobalEvent) {
        // One listener failing on an event must not stop the other listeners from receiving it.
        for (const handler of handlers) {
          try {
            handler(event)
          } catch (error) {
            console.error("tui: event listener failed; skipping it for this event", (event as any)?.payload?.type, error)
          }
        }
      },
      on(_type: "event", handler: (event: GlobalEvent) => void) {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
    }

    let queue: GlobalEvent[] = []
    let timer: Timer | undefined
    let last = 0
    const retryDelay = 1000
    const maxRetryDelay = 30000

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      // Batch all event emissions so all store updates result in a single render. Each event is isolated: a
      // handler that throws on one malformed event must not take the rest of the batch — or the SSE loop that
      // called us — down with it. (One bad `session.deleted` used to end live updates for the whole run.)
      batch(() => {
        for (const event of events) {
          try {
            emitter.emit("event", event)
          } catch (error) {
            console.error("tui: event handler failed; skipping this event", (event as any)?.payload?.type, error)
          }
        }
      })
    }

    const handleEvent = (event: GlobalEvent) => {
      queue.push(event)
      const elapsed = Date.now() - last

      if (timer) return
      // If we just flushed recently (within 16ms), batch this with future events
      // Otherwise, process immediately to avoid latency
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    // The engine sends a heartbeat every 10s. A connection can die SILENTLY — the socket stays "open" after a
    // sleep/resume or a network blip but nothing arrives, and no error is ever raised — which left the screen
    // frozen while the engine kept answering. If nothing at all arrives for this long, drop it and reconnect
    // (the reconnect's server.connected makes sync re-fetch what is open, see sync.tsx).
    const SILENT_LIMIT_MS = 30_000

    function startSSE() {
      sse?.abort()
      const ctrl = new AbortController() // the whole loop's life
      sse = ctrl
      // ONE loop for the whole run; each pass is one connection with its own abort switch. The watchdog only
      // cuts the current connection — the same loop then reconnects. (Restarting the whole loop from the
      // watchdog left the app with the dead connection closed and no new one opened.)
      let connection: AbortController | undefined
      let lastSeen = Date.now()
      let cutByWatchdog = false
      const watchdog = setInterval(() => {
        if (ctrl.signal.aborted || abort.signal.aborted) return clearInterval(watchdog)
        if (!connection || Date.now() - lastSeen < SILENT_LIMIT_MS) return
        lastSeen = Date.now() // give the reconnect its own window before judging it
        cutByWatchdog = true
        console.error("tui: no live updates for 30s (silently dead connection); reconnecting")
        try {
          connection.abort()
        } catch {}
      }, 5_000)
      ctrl.signal.addEventListener("abort", () => {
        clearInterval(watchdog)
        try {
          connection?.abort()
        } catch {}
      })
      ;(async () => {
        let attempt = 0
        while (true) {
          if (abort.signal.aborted || ctrl.signal.aborted) break
          const conn = new AbortController()
          connection = conn

          // Anything that goes wrong in one pass (the connection dropping or going silent, the engine restarting,
          // a bad event) ends only that pass: we reconnect. Before, any error escaped to the `.catch(() => {})`
          // below and silently ended live updates for the rest of the run.
          try {
            const events = await sdk.global.event({
              signal: conn.signal,
              sseMaxRetryAttempts: 0,
            })

            if (Flag.ORYNR_EXPERIMENTAL_WORKSPACES) {
              // Start syncing workspaces, it's important to do this after
              // we've started listening to events
              await sdk.sync.start().catch(() => {})
            }

            lastSeen = Date.now()
            for await (const event of events.stream) {
              if (ctrl.signal.aborted || conn.signal.aborted) break
              lastSeen = Date.now() // heartbeats count: they prove the connection is alive
              attempt = 0 // a live stream resets the backoff
              handleEvent(event)
            }
          } catch (error) {
            if (abort.signal.aborted || ctrl.signal.aborted) break
            if (!conn.signal.aborted) console.error("tui: live updates dropped; reconnecting", error)
          }

          if (timer) clearTimeout(timer)
          if (queue.length > 0) flush()
          if (abort.signal.aborted || ctrl.signal.aborted) break

          // A connection the watchdog cut is replaced at once; real failures back off exponentially.
          if (cutByWatchdog) {
            cutByWatchdog = false
            attempt = 0
            continue
          }
          attempt += 1
          const backoff = Math.min(retryDelay * 2 ** (attempt - 1), maxRetryDelay)
          await new Promise((resolve) => setTimeout(resolve, backoff))
        }
      })().catch((error) => console.error("tui: live-update loop stopped", error))
    }

    onMount(async () => {
      if (props.events) {
        const unsub = await props.events.subscribe(handleEvent)
        onCleanup(unsub)

        if (Flag.ORYNR_EXPERIMENTAL_WORKSPACES) {
          // Start syncing workspaces, it's important to do this after
          // we've started listening to events
          await sdk.sync.start().catch(() => {})
        }
      } else {
        startSSE()
      }
    })

    onCleanup(() => {
      abort.abort()
      sse?.abort()
      if (timer) clearTimeout(timer)
      handlers.clear()
    })

    return {
      get client() {
        return sdk
      },
      get directory() {
        return currentDirectory
      },
      // Switch the active project directory. Recreates the client so all subsequent calls carry the
      // new ?directory=; the `client` getter above means every consumer picks up the new client.
      setDirectory(dir: string) {
        currentDirectory = dir
        sdk = createSDK()
      },
      event: emitter,
      fetch: props.fetch ?? fetch,
      url: props.url,
    }
  },
})
