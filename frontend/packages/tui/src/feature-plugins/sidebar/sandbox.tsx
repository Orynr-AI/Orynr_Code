import type { TuiPlugin, TuiPluginApi } from "@orynr-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show } from "solid-js"
import { useContainerState } from "../../component/home-status"
import { useTuiPaths } from "../../context/runtime"

// Session-sidebar section: which sandbox the agent's commands run in, with the REAL
// container id/state queried from the docker daemon (not a config echo).
const id = "internal:sidebar-sandbox"

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const paths = useTuiPaths()
  const info = createMemo(
    () =>
      (
        props.api.state.config as {
          sandbox?: {
            runtime?: string
            label?: string
            container?: string
            docker_installed?: boolean
            docker_running?: boolean
          }
        }
      ).sandbox ?? {},
  )
  const runtime = createMemo(() => info().runtime ?? "local")
  // Why a project runs on this PC rather than in a container (Sai, 2026-10-03).
  const dockerNote = createMemo(() => {
    if (runtime() === "docker") return undefined
    if (info().docker_installed === false) return "Docker is not installed, using local project folder"
    if (info().docker_running === false) return "Docker isn't running, using local project folder"
    return undefined
  })
  const container = useContainerState(() =>
    runtime() === "docker" ? info().container || props.api.state.path.directory || paths.cwd : undefined,
  )
  const running = createMemo(() => container()?.startsWith("running") === true)

  return (
    <box>
      <text fg={theme().text}>
        <b>Sandbox</b>
      </text>
      <box flexDirection="row" gap={1}>
        <text
          flexShrink={0}
          style={{ fg: runtime() === "docker" ? (running() ? theme().success : theme().warning) : theme().textMuted }}
        >
          ●
        </text>
        <text fg={theme().text}>{info().label ?? runtime()}</text>
      </box>
      <Show when={runtime() === "docker"}>
        <text fg={theme().textMuted}>{container() ?? "checking…"}</text>
      </Show>
      <Show when={dockerNote()}>
        <text fg={theme().textMuted} wrapMode="word">
          {dockerNote()}
        </text>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 350,
    slots: {
      sidebar_content() {
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
