import { createMemo, For, Show } from "solid-js"
import { useSync } from "../context/sync"
import { useRoute } from "../context/route"
import { useTheme } from "../context/theme"

// A chat that is waiting for the user - a permission to allow, or a question to answer - must be visible on screen
// wherever the user is (Sai, 2026-10-03: "make sure the permission stuff is on screen or else the user won't know").
// The open chat already shows its own prompts and its helpers' ones; this bar names every OTHER chat that is waiting,
// stays until it is answered, and opens that chat when clicked.
export function WaitingBar() {
  const sync = useSync()
  const route = useRoute()
  const { theme } = useTheme()

  // the top-level chat a session belongs to (a helper's prompt is shown in its parent chat)
  function rootOf(id: string): string {
    let cur = id
    for (let i = 0; i < 20; i++) {
      const parent = sync.session.get(cur)?.parentID
      if (!parent) return cur
      cur = parent
    }
    return cur
  }

  const waiting = createMemo(() => {
    const open = route.data.type === "session" ? rootOf(route.data.sessionID) : undefined
    const out = new Map<string, { kind: string; count: number }>()
    const add = (sid: string, kind: string, n: number) => {
      if (!n) return
      const root = rootOf(sid)
      if (root === open) return
      const cur = out.get(root)
      out.set(root, { kind: cur && cur.kind !== kind ? "permission and answer" : kind, count: (cur?.count ?? 0) + n })
    }
    for (const [sid, reqs] of Object.entries(sync.data.permission ?? {})) add(sid, "permission", (reqs ?? []).length)
    for (const [sid, reqs] of Object.entries(sync.data.question ?? {})) add(sid, "answer", (reqs ?? []).length)
    return [...out.entries()].map(([id, v]) => ({ id, ...v, title: sync.session.get(id)?.title || "a chat" }))
  })

  return (
    <Show when={waiting().length > 0}>
      <box flexShrink={0} flexDirection="column" paddingLeft={1} paddingRight={1} backgroundColor={theme.backgroundPanel}>
        <For each={waiting()}>
          {(item) => (
            <box
              flexDirection="row"
              onMouseUp={() => route.navigate({ type: "session", sessionID: item.id })}
            >
              <text fg={theme.warning} wrapMode="none">
                {"⚠ "}
                <span style={{ fg: theme.text }}>{`"${item.title}"`}</span>
                {` is waiting for your ${item.kind === "permission" ? "permission" : item.kind}`}
                <span style={{ fg: theme.textMuted }}>{" - click here (or /sessions) to open it"}</span>
              </text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}
