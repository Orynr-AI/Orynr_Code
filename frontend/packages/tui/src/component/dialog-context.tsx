import { TextAttributes } from "@opentui/core"
import { createResource, For, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useDialog } from "../ui/dialog"

// /context - how full the model's working memory is for this conversation, and what fills it.
type Part = { name: string; tokens: number }
type Report = {
  model: string
  agent: string
  window: number
  usable: number
  parts: Part[]
  estimate: number
  last_actual: number
  used: number
  room_before_condense: number | null
}

const fmt = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)}K` : n.toLocaleString())

export function DialogContext(props: { sessionID: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const { theme } = useTheme()
  const [report] = createResource(async (): Promise<Report | undefined> => {
    try {
      const res = await sdk.fetch(`${sdk.url}/session/${props.sessionID}/context`)
      return res.ok ? ((await res.json()) as Report) : undefined
    } catch {
      return undefined
    }
  })
  const width = 40
  const bar = (tokens: number, of: number) => {
    const n = of > 0 ? Math.max(tokens > 0 ? 1 : 0, Math.round((tokens / of) * width)) : 0
    return "█".repeat(Math.min(width, n)) + "░".repeat(Math.max(0, width - n))
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Context
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show when={report()} fallback={<text fg={theme.textMuted}>{report.loading ? "Measuring…" : "No data yet."}</text>}>
        {(r) => {
          const of = () => r().usable || r().window || r().estimate || 1
          return (
            <box gap={1}>
              <text fg={theme.textMuted}>
                {r().agent} · {r().model}
              </text>
              <box>
                <text fg={theme.text}>
                  <b>{fmt(r().used)}</b> tokens in use
                  <Show when={r().usable || r().window}>
                    <span style={{ fg: theme.textMuted }}>
                      {" "}
                      of {fmt(r().usable || r().window)} ({Math.round((r().used / of()) * 100)}%)
                    </span>
                  </Show>
                </text>
                <text fg={r().used / of() > 0.8 ? theme.warning : theme.success}>{bar(r().used, of())}</text>
                <Show
                  when={r().room_before_condense !== null}
                  fallback={
                    <text fg={theme.textMuted}>This model's window size isn't known, so there is no condense point.</text>
                  }
                >
                  <text fg={theme.textMuted}>
                    {fmt(r().room_before_condense ?? 0)} tokens of room before the conversation is condensed automatically
                  </text>
                </Show>
              </box>
              <box>
                <text fg={theme.text}>
                  <b>What the next message carries</b>
                  <span style={{ fg: theme.textMuted }}> (estimate: {fmt(r().estimate)})</span>
                </text>
                <For each={r().parts}>
                  {(p) => (
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={theme.text}>{p.name}</text>
                      <text fg={theme.textMuted}>{fmt(p.tokens)}</text>
                    </box>
                  )}
                </For>
              </box>
              <text fg={theme.textMuted} wrapMode="word">
                "In use" is what the model last reported; the breakdown is an estimate. /compact condenses now.
              </text>
            </box>
          )
        }}
      </Show>
    </box>
  )
}
