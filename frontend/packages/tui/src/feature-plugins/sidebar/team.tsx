import type { TuiPlugin, TuiPluginApi } from "@orynr-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"

// Session-sidebar section: the helpers working for this conversation (live: what each is on, how long, how many
// steps) and the background reviewer's list of what is still missing. Read from the engine's /session/<id>/team.
const id = "internal:sidebar-team"

type Helper = {
  id: string
  description: string
  subagent: string
  state: string
  elapsed: string
  tool_calls: number
  now: string
  background: boolean
}
type Item = { id: string; text: string; severity?: string; status: string; group: string; note?: string }
type Team = { helpers: Helper[]; review: Item[] }

type RawClient = { get(options: { url: string }): Promise<{ data?: unknown }> }

async function readTeam(api: TuiPluginApi, sessionID: string): Promise<Team> {
  try {
    const raw = (api.client as unknown as { client: RawClient }).client
    const result = await raw.get({ url: `/session/${sessionID}/team` })
    const data = result.data as Team | undefined
    return { helpers: data?.helpers ?? [], review: data?.review ?? [] }
  } catch {
    return { helpers: [], review: [] }
  }
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const [tick, setTick] = createSignal(0)
  const timer = setInterval(() => setTick((v) => v + 1), 2000)
  onCleanup(() => clearInterval(timer))
  const [team] = createResource(
    () => [props.session_id, tick()] as const,
    ([sid]) => readTeam(props.api, sid),
  )
  const helpers = () => team()?.helpers ?? []
  const review = () => team()?.review ?? []
  const group = (g: string) => review().filter((i) => i.group === g)

  const mark = (state: string) =>
    state === "running"
      ? { ch: "●", fg: theme().warning }
      : state === "completed"
        ? { ch: "✓", fg: theme().success }
        : state === "partial" || state === "stopped" || state === "interrupted"
          ? { ch: "◐", fg: theme().warning }
          : { ch: "✗", fg: theme().error }

  return (
    <box gap={1}>
      <Show when={helpers().length > 0}>
        <box>
          <text fg={theme().text}>
            <b>Helpers</b>
            <span style={{ fg: theme().textMuted }}>
              {" "}
              {helpers().filter((h) => h.state === "running").length} working
            </span>
          </text>
          <For each={helpers()}>
            {(h) => (
              <box>
                <box flexDirection="row" gap={1}>
                  <text flexShrink={0} style={{ fg: mark(h.state).fg }}>
                    {mark(h.state).ch}
                  </text>
                  <text fg={theme().text} wrapMode="word">
                    {h.description}
                    <span style={{ fg: theme().textMuted }}>
                      {" "}
                      · {h.state === "running" ? h.elapsed : h.state} · {h.tool_calls} steps
                    </span>
                  </text>
                </box>
                <Show when={h.now}>
                  <text fg={theme().textMuted} wrapMode="none">
                    {"  "}
                    {h.now}
                  </text>
                </Show>
              </box>
            )}
          </For>
        </box>
      </Show>
      <Show when={review().length > 0}>
        <box gap={1}>
          <Show when={group("todo").length > 0}>
            <box>
              <text fg={theme().text}>
                <b>Still to do</b>
                <span style={{ fg: theme().textMuted }}> {group("todo").length}</span>
              </text>
              <For each={group("todo")}>
                {(i) => (
                  <box flexDirection="row" gap={1}>
                    <text flexShrink={0} fg={i.severity === "high" ? theme().error : theme().warning}>
                      –
                    </text>
                    <text fg={theme().text} wrapMode="word">
                      {i.text}
                      <Show when={i.severity === "high"}>
                        <span style={{ fg: theme().error }}> (important)</span>
                      </Show>
                    </text>
                  </box>
                )}
              </For>
            </box>
          </Show>
          <Show when={group("blocked").length > 0}>
            <box>
              <text fg={theme().text}>
                <b>Needs you</b>
                <span style={{ fg: theme().textMuted }}> {group("blocked").length}</span>
              </text>
              <For each={group("blocked")}>
                {(i) => (
                  <box flexDirection="row" gap={1}>
                    <text flexShrink={0} fg={theme().secondary}>
                      →
                    </text>
                    <text fg={theme().text} wrapMode="word">
                      {i.text}
                      <Show when={i.note}>
                        <span style={{ fg: theme().textMuted }}> — needs: {i.note}</span>
                      </Show>
                    </text>
                  </box>
                )}
              </For>
            </box>
          </Show>
          <Show when={group("done").length > 0}>
            <box>
              <text fg={theme().text}>
                <b>Done</b>
                <span style={{ fg: theme().textMuted }}> {group("done").length}</span>
              </text>
              <For each={group("done")}>
                {(i) => (
                  <box flexDirection="row" gap={1}>
                    <text flexShrink={0} fg={theme().success}>
                      ✓
                    </text>
                    <text fg={theme().textMuted} wrapMode="word">
                      {i.text}
                    </text>
                  </box>
                )}
              </For>
            </box>
          </Show>
        </box>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
