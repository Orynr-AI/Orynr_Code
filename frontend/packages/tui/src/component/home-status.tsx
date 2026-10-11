import { createMemo, createResource, createSignal, onCleanup, Show, type Resource } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useSync } from "../context/sync"
import { useLocal } from "../context/local"
import { useTheme } from "../context/theme"
import { useProject } from "../context/project"

// Mirrors orynr/src/sandbox/sandbox.ts containerName() — keep in sync.
export function containerName(root: string) {
  const hash = Buffer.from(root)
    .toString("base64")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-24)
    .toLowerCase()
  return `orynr-sandbox-${hash}`
}

// Live-polling container state. The eager warm can take a moment to start the container
// (first run pulls the image), so a ONE-SHOT probe would freeze on the initial
// "starts on first command" and never show it come up. This re-queries the daemon every
// few seconds while the source (project dir) is docker-active.
export function useContainerState(root: () => string | undefined): Resource<string | undefined> {
  const [tick, setTick] = createSignal(0)
  const timer = setInterval(() => setTick((value) => value + 1), 3000)
  onCleanup(() => clearInterval(timer))
  const [state] = createResource(
    () => {
      const dir = root()
      return dir ? ([dir, tick()] as const) : undefined
    },
    ([dir]) => containerState(dir),
  )
  return state
}

// REAL container state (not a config echo): asks the docker daemon whether the
// project's container exists/runs. Returns a short display string or undefined.
export async function containerState(root: string): Promise<string | undefined> {
  try {
    // The engine reports the container's name (it depends on the project's mode); a folder still works too.
    const name = root.startsWith("orynr-sandbox-") ? root : containerName(root)
    const proc = Bun.spawn(
      ["docker", "ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.ID}} {{.State}}"],
      { stdout: "pipe", stderr: "ignore" },
    )
    const out = (await new Response(proc.stdout).text()).trim()
    if ((await proc.exited) !== 0) return "daemon unreachable"
    if (!out) return "starts on first command"
    const [id, state] = out.split(" ")
    return `${state} · ${id}`
  } catch {
    return "daemon unreachable"
  }
}

/** Compact live-status card for the home screen: model, MCP, LSP, sandbox, branch. */
export function HomeStatus() {
  const sync = useSync()
  const local = useLocal()
  const { theme } = useTheme()

  const model = createMemo(() => {
    const current = local.model.current()
    return current ? current.modelID : undefined
  })
  const mcp = createMemo(() => {
    const entries = Object.values(sync.data.mcp)
    const connected = entries.filter((item) => item.status === "connected").length
    return { connected, total: entries.length }
  })
  const lsp = createMemo(() => sync.data.lsp.length)
  // Generated SDK config type doesn't carry `sandbox` yet — same cast the /sandbox plugin uses. The engine fills in
  // this project's own mode (label) and container name.
  const sandboxInfo = createMemo(
    () => (sync.data.config as { sandbox?: { runtime?: string; label?: string; container?: string } }).sandbox ?? {},
  )
  const sandbox = createMemo(() => sandboxInfo().runtime ?? "local")
  const branch = createMemo(() => sync.data.vcs?.branch)
  const project = useProject()
  const container = useContainerState(() =>
    sandbox() === "docker" ? sandboxInfo().container || project.data.instance.path.directory || process.cwd() : undefined,
  )

  const Row = (props: { label: string; value: string; ok?: boolean }) => (
    <box flexDirection="row" gap={1}>
      <text fg={props.ok === false ? theme.textMuted : theme.success} selectable={false}>
        ●
      </text>
      <text fg={theme.textMuted} selectable={false}>
        {props.label}
      </text>
      <text fg={theme.text} selectable={false}>
        {props.value}
      </text>
    </box>
  )

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={theme.borderSubtle}
      paddingLeft={2}
      paddingRight={2}
      title=" status "
      titleColor={theme.textMuted}
      backgroundColor={theme.background}
      gap={0}
    >
      <Show when={model()}>
        <Row label="model" value={model()!} />
      </Show>
      <Row label="mcp" value={mcp().total === 0 ? "none" : `${mcp().connected}/${mcp().total} connected`} ok={mcp().total === 0 ? false : mcp().connected > 0} />
      <Row label="lsp" value={lsp() === 0 ? "none installed" : `${lsp()} ready`} ok={lsp() > 0} />
      <Row label="sandbox" value={sandboxInfo().label ?? sandbox()} />
      <Show when={sandbox() === "docker"}>
        <Row
          label="container"
          value={container() ?? "checking…"}
          ok={container()?.startsWith("running") === true}
        />
      </Show>
      <Show when={branch()}>
        <Row label="branch" value={branch()!} />
      </Show>
    </box>
  )
}

