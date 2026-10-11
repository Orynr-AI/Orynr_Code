import { TextAttributes } from "@opentui/core"
import { createResource, For, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useDialog } from "../ui/dialog"

// /usage - what this conversation has used (the agent, its helpers, the background reviewer) and the last 7/30 days.
type Use = { input: number; output: number; cost: number; turns?: number; ms?: number; calls?: number; count?: number }
type Period = { days: number; sessions: number; input: number; output: number; cost: number }
type Report = {
  agent: Use
  helpers: Use
  reviewer: Use
  total: { input: number; output: number; cost: number }
  models: Record<string, { input: number; output: number; cost: number; turns: number }>
  top_tools: [string, number][]
  last7: Period
  last30: Period
}

const fmt = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)}K` : Math.round(n).toLocaleString())
const money = (n: number) => (n > 0 ? `$${n.toFixed(n < 1 ? 4 : 2)}` : "free")
const time = (ms?: number) => {
  const s = Math.round((ms ?? 0) / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

export function DialogUsage(props: { sessionID: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const { theme } = useTheme()
  const [report] = createResource(async (): Promise<Report | undefined> => {
    try {
      const res = await sdk.fetch(`${sdk.url}/session/${props.sessionID}/usage`)
      return res.ok ? ((await res.json()) as Report) : undefined
    } catch {
      return undefined
    }
  })

  const Row = (p: { label: string; value: string; note?: string }) => (
    <box flexDirection="row" justifyContent="space-between" gap={2}>
      <text fg={theme.text} flexShrink={0}>
        {p.label}
      </text>
      <text fg={theme.textMuted}>
        {p.value}
        <Show when={p.note}>
          <span> · {p.note}</span>
        </Show>
      </text>
    </box>
  )

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Usage
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show when={report()} fallback={<text fg={theme.textMuted}>{report.loading ? "Adding it up…" : "No data yet."}</text>}>
        {(r) => (
          <box gap={1}>
            <box>
              <text fg={theme.text}>
                <b>This conversation</b>
                <span style={{ fg: theme.textMuted }}>
                  {" "}
                  {fmt(r().total.input)} in · {fmt(r().total.output)} out · {money(r().total.cost)}
                </span>
              </text>
              <Row
                label="Agent"
                value={`${fmt(r().agent.input)} in · ${fmt(r().agent.output)} out`}
                note={`${r().agent.turns ?? 0} replies, ${time(r().agent.ms)}`}
              />
              <Row
                label={`Helpers (${r().helpers.count ?? 0})`}
                value={`${fmt(r().helpers.input)} in · ${fmt(r().helpers.output)} out`}
                note={time(r().helpers.ms)}
              />
              <Row
                label="Reviewer"
                value={`${fmt(r().reviewer.input)} in · ${fmt(r().reviewer.output)} out`}
                note={`${r().reviewer.calls ?? 0} checks`}
              />
            </box>
            <Show when={Object.keys(r().models).length > 0}>
              <box>
                <text fg={theme.text}>
                  <b>By model</b>
                <span style={{ fg: theme.textMuted }}> (agent + helpers)</span>
                </text>
                <For each={Object.entries(r().models)}>
                  {([name, m]) => (
                    <Row label={name} value={`${fmt(m.input)} in · ${fmt(m.output)} out`} note={money(m.cost)} />
                  )}
                </For>
              </box>
            </Show>
            <Show when={r().top_tools.length > 0}>
              <text fg={theme.textMuted} wrapMode="word">
                Tools used: {r().top_tools.map(([name, n]) => `${name} ${n}`).join(", ")}
              </text>
            </Show>
            <box>
              <text fg={theme.text}>
                <b>All conversations</b>
              </text>
              <For each={[r().last7, r().last30]}>
                {(p) => (
                  <Row
                    label={`Last ${p.days} days`}
                    value={`${fmt(p.input)} in · ${fmt(p.output)} out`}
                    note={`${p.sessions} conversations, ${money(p.cost)}`}
                  />
                )}
              </For>
            </box>
          </box>
        )}
      </Show>
    </box>
  )
}
