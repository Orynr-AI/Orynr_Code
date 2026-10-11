import type { TuiPlugin, TuiPluginApi } from "@orynr-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Match, Show, Switch } from "solid-js"
import { abbreviateHome } from "../../runtime"
import { useTuiPaths } from "../../context/runtime"
import { useHomeSessionDestination } from "../../routes/home/session-destination"
import { useContainerState } from "../../component/home-status"

const id = "internal:home-footer"

function Directory(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const destination = useHomeSessionDestination()
  const paths = useTuiPaths()
  const docker = createMemo(
    () => (props.api.state.config as { sandbox?: { runtime?: string } }).sandbox?.runtime === "docker",
  )
  const dir = createMemo(() => {
    const selected = destination?.destination()
    if (!selected || selected.type === "new") return
    const branch =
      selected.directory === (props.api.state.path.directory || paths.cwd) ? props.api.state.vcs?.branch : undefined
    // Docker mode: the agent's world is /workspace — show that, with the host source dimmed.
    const out = docker()
      ? `/workspace (${abbreviateHome(selected.directory, paths.home)})`
      : abbreviateHome(selected.directory, paths.home)
    if (branch) return out + ":" + branch
    return out
  })

  return <Show when={dir()}>{(value) => <text fg={theme().textMuted}>{value()}</text>}</Show>
}

function Mcp(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.mcp())
  const has = createMemo(() => list().length > 0)
  const err = createMemo(() => list().some((item) => item.status === "failed"))
  const count = createMemo(() => list().filter((item) => item.status === "connected").length)

  return (
    <Show when={has()}>
      <box gap={1} flexDirection="row" flexShrink={0}>
        <text fg={theme().text}>
          <Switch>
            <Match when={err()}>
              <span style={{ fg: theme().error }}>⊙ </span>
            </Match>
            <Match when={true}>
              <span style={{ fg: count() > 0 ? theme().success : theme().textMuted }}>⊙ </span>
            </Match>
          </Switch>
          {count()} MCP
        </text>
        <text fg={theme().textMuted}>/status</text>
      </box>
    </Show>
  )
}

// Bottom-bar sandbox chip: "▣ docker · <state · id>" (live from the daemon) or "▣ local".
export function SandboxChip(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const info = createMemo(
    () => (props.api.state.config as { sandbox?: { runtime?: string; label?: string; container?: string } }).sandbox ?? {},
  )
  const runtime = createMemo(() => info().runtime ?? "local")
  const paths = useTuiPaths()
  const container = useContainerState(() =>
    runtime() === "docker" ? info().container || props.api.state.path.directory || paths.cwd : undefined,
  )
  const running = createMemo(() => container()?.startsWith("running") === true)

  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <text fg={runtime() === "docker" ? (running() ? theme().success : theme().warning) : theme().textMuted}>▣</text>
      <text fg={theme().text}>{info().label ?? runtime()}</text>
      <Show when={runtime() === "docker"}>
        <text fg={theme().textMuted}>{container() ?? "checking…"}</text>
      </Show>
    </box>
  )
}

function Version(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current

  return (
    <box flexShrink={0}>
      <text fg={theme().textMuted}>{props.api.app.version}</text>
    </box>
  )
}

function View(props: { api: TuiPluginApi }) {
  return (
    <box
      width="100%"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      flexDirection="row"
      flexShrink={0}
      gap={2}
    >
      <Directory api={props.api} />
      <Mcp api={props.api} />
      <box flexGrow={1} />
      <SandboxChip api={props.api} />
      <Version api={props.api} />
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      home_footer() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
