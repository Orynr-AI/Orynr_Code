import type { TuiPlugin, TuiPluginApi } from "@orynr-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal } from "solid-js"
import path from "path"
import fs from "fs/promises"
import { refreshServerConfig } from "../../context/sync"
import { DialogSelect } from "../../ui/dialog-select"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { useTuiPaths } from "../../context/runtime"

// In-console `/sandbox`: pick how the open project runs, copy a folder into it, or open another project folder.
//
// Three modes (the engine owns them - orynr_server/sandbox/modes.py - and remembers each project's choice):
//   Docker               files in <project>\docker, commands in a container with internet only
//   Docker shared local  the container works on the project folder itself, internet only
//   Local                commands run directly on this PC
// Switching between Docker and the other two MOVES the project's files between <project> and <project>\docker; the
// engine checks for name clashes first and never overwrites.
const id = "internal:sandbox-runtime"

type Mode = "docker" | "docker-shared" | "local"
type Status = {
  mode: Mode
  label: string
  docker_available: boolean
  project: string
  workspace: string
  name: string
  lobby: boolean
  projects_root: string
}
type Reply = { ok?: boolean; error?: string; clashes?: string[]; moved?: number; files?: number; path?: string }

const LABELS: Record<Mode, string> = { docker: "Docker", "docker-shared": "Docker shared local", local: "Local" }

// The generated SDK has no methods for these engine routes yet; its underlying client still adds the base URL and
// the current project folder (the x-orynr-directory header / ?directory=), so every call hits the open project.
type RawClient = {
  get(options: { url: string }): Promise<{ data?: unknown; response?: Response }>
  post(options: { url: string; body?: unknown; headers?: Record<string, string> }): Promise<{
    data?: unknown
    error?: unknown
    response?: Response
  }>
}
function raw(api: TuiPluginApi): RawClient {
  return (api.client as unknown as { client: RawClient }).client
}

async function readStatus(api: TuiPluginApi): Promise<Status | undefined> {
  try {
    const result = await raw(api).get({ url: "/sandbox" })
    return result.data as Status
  } catch {
    return undefined
  }
}

async function post(api: TuiPluginApi, url: string, body: unknown): Promise<Reply> {
  try {
    const result = await raw(api).post({ url, body, headers: { "Content-Type": "application/json" } })
    return ((result.data ?? result.error) as Reply) ?? { ok: false, error: "no answer from the engine" }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function describeSwitch(st: Status, next: Mode): string {
  const project = st.project
  const dockerDir = path.join(project, "docker")
  if (next === "docker")
    return (
      `The project's files move from ${project} into ${dockerDir}. From then on commands run in a container that can ` +
      "reach the internet and nothing else. Code intelligence and the app preview are off in Docker mode."
    )
  if (st.mode === "docker")
    return (
      `The project's files move from ${dockerDir} back into ${project}, and the container is removed (tools installed ` +
      `inside it are lost; your files are kept). ` +
      (next === "local" ? "Commands will run on this PC." : "Commands will still run in a container, on this folder.")
    )
  return next === "local"
    ? "Nothing moves. Commands will run directly on this PC; the container is removed."
    : "Nothing moves. Commands will run in a container that works on this folder, with internet only."
}

function switchTo(api: TuiPluginApi, st: Status, next: Mode) {
  api.ui.dialog.replace(() => (
    <api.ui.DialogConfirm
      title={`Switch "${st.name}" to ${LABELS[next]}?`}
      message={describeSwitch(st, next)}
      onCancel={() => api.ui.dialog.clear()}
      onConfirm={() => {
        api.ui.dialog.clear()
        void (async () => {
          api.ui.toast({ message: `Switching to ${LABELS[next]}…` })
          const reply = await post(api, "/project/mode", { mode: next })
          if (reply.ok) {
            await refreshServerConfig()
            const moved = reply.moved ? ` — moved ${reply.moved} item${reply.moved === 1 ? "" : "s"}` : ""
            api.ui.toast({ variant: "success", message: `${st.name} is now ${LABELS[next]}${moved}` })
            return
          }
          if (reply.clashes && reply.clashes.length > 0) {
            api.ui.dialog.replace(() => (
              <api.ui.DialogAlert
                title="Nothing was moved"
                message={
                  "These names already exist where the files would go, and Orynr never overwrites:\n\n" +
                  reply.clashes!.slice(0, 12).join("\n") +
                  (reply.clashes!.length > 12 ? `\n… and ${reply.clashes!.length - 12} more` : "") +
                  "\n\nRename or remove them, then switch again."
                }
                onConfirm={() => api.ui.dialog.clear()}
              />
            ))
            return
          }
          api.ui.toast({ variant: "error", message: `Could not switch: ${reply.error ?? "unknown error"}` })
        })()
      }}
    />
  ))
}

function expandPath(input: string, home: string): string {
  let s = input.trim().replace(/^["']+|["']+$/g, "") // drop pasted surrounding quotes
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) s = path.join(home, s.slice(1))
  return path.resolve(s)
}

// The user picks a folder on this PC and it is copied into the project (into <project>\docker in Docker mode, where
// the container can see it). A TUI action on purpose: the model itself can never reach the PC's folders.
function ImportFolderDialog(props: { api: TuiPluginApi; status: Status }) {
  const paths = useTuiPaths()
  const theme = () => props.api.theme.current
  const [busy, setBusy] = createSignal(false)
  const into = props.status.mode === "docker" ? props.status.workspace : props.status.project

  return (
    <DialogPrompt
      title="Copy a folder into the project"
      description={() => (
        <text fg={theme().textMuted} wrapMode="word">
          Paste the path of a folder on this PC. A copy goes into {into}
          {props.status.mode === "docker" ? " (the container sees it at /workspace)" : ""}. The original is not changed.
        </text>
      )}
      value=""
      placeholder={paths.home}
      busy={busy()}
      busyText="Copying…"
      onConfirm={(value) => {
        if (!value.trim()) return
        const source = expandPath(value, paths.home)
        setBusy(true)
        void (async () => {
          const reply = await post(props.api, "/project/import", { source })
          props.api.ui.dialog.clear()
          if (reply.ok)
            props.api.ui.toast({ variant: "success", message: `Copied ${reply.files ?? 0} files → ${reply.path}` })
          else props.api.ui.toast({ variant: "error", message: `Could not copy: ${reply.error ?? "unknown error"}` })
        })()
      }}
    />
  )
}

// Paste any folder path to use it as the project. An existing folder opens directly; a missing one
// offers to create it first. Opening re-roots the whole session (see api.app.openDirectory).
function OpenFolderDialog(props: { api: TuiPluginApi; projectsRoot?: string }) {
  const paths = useTuiPaths()
  const theme = () => props.api.theme.current
  const defaultProjects = props.projectsRoot || path.join(paths.home, "Documents", "Orynr_Projects")
  const [busy, setBusy] = createSignal(false)

  async function open(folder: string) {
    await props.api.app.openDirectory(folder)
    props.api.ui.dialog.clear()
    props.api.ui.toast({ message: `Project folder: ${folder}` })
  }

  return (
    <DialogPrompt
      title="Open a project folder"
      description={() => (
        <text fg={theme().textMuted} wrapMode="word">
          Paste a folder path to open it as the project. If it doesn't exist you'll be offered to create it.
        </text>
      )}
      value={defaultProjects}
      placeholder={defaultProjects}
      busy={busy()}
      busyText="Opening…"
      onConfirm={(value) => {
        const folder = expandPath(value || defaultProjects, paths.home)
        setBusy(true)
        void (async () => {
          try {
            let isDir = false
            try {
              isDir = (await fs.stat(folder)).isDirectory()
            } catch {}
            if (isDir) {
              await open(folder)
              return
            }
            setBusy(false)
            props.api.ui.dialog.replace(() => (
              <DialogSelect
                title={`"${folder}" doesn't exist`}
                options={[
                  { title: "create it and open", value: "create" as const, description: folder },
                  { title: "cancel", value: "cancel" as const, description: "go back" },
                ]}
                onSelect={(opt) => {
                  if (opt.value !== "create") {
                    props.api.ui.dialog.clear()
                    return
                  }
                  void (async () => {
                    try {
                      await fs.mkdir(folder, { recursive: true })
                      await open(folder)
                    } catch (err) {
                      props.api.ui.dialog.clear()
                      props.api.ui.toast({
                        variant: "error",
                        message: `Could not create ${folder}: ${err instanceof Error ? err.message : String(err)}`,
                      })
                    }
                  })()
                }}
              />
            ))
          } catch (err) {
            setBusy(false)
            props.api.ui.dialog.clear()
            props.api.ui.toast({
              variant: "error",
              message: `Could not open ${folder}: ${err instanceof Error ? err.message : String(err)}`,
            })
          }
        })()
      }}
    />
  )
}

function show(api: TuiPluginApi) {
  void (async () => {
    const st = await readStatus(api)
    if (!st) {
      api.ui.toast({ variant: "error", message: "Couldn't read the project's sandbox settings from the engine" })
      return
    }
    const current = (mode: Mode) => (st.mode === mode ? "current" : undefined)
    const dockerNote = st.docker_available ? [] : ["Docker Desktop isn't running — start it to use this"]
    type Choice = Mode | "__import__" | "__folder__"
    api.ui.dialog.replace(() => (
      <DialogSelect
        title={st.lobby ? "Sandbox — no project yet" : `Sandbox — ${st.name}`}
        options={[
          {
            title: "Docker",
            value: "docker" as Choice,
            description: "files in <project>\\docker · commands in a container with internet only",
            details: dockerNote,
            footer: current("docker"),
          },
          {
            title: "Docker shared local",
            value: "docker-shared" as Choice,
            description: "the container works on this project folder · internet only",
            details: dockerNote,
            footer: current("docker-shared"),
          },
          {
            title: "Local",
            value: "local" as Choice,
            description: "commands run directly on this PC",
            footer: current("local"),
          },
          ...(st.lobby
            ? []
            : [
                {
                  title: "copy a folder into the project",
                  value: "__import__" as Choice,
                  description:
                    st.mode === "docker" ? "a copy goes into the docker folder, where the container sees it" : "a copy goes into this project folder",
                },
              ]),
          {
            title: "change project folder",
            value: "__folder__" as Choice,
            description: "open a different folder as the project (paste a path)",
            details: [`current: ${st.project}`],
          },
        ]}
        onSelect={(option) => {
          const choice = option.value as Choice
          if (choice === "__folder__") {
            api.ui.dialog.replace(() => <OpenFolderDialog api={api} projectsRoot={st.projects_root} />)
            return
          }
          if (choice === "__import__") {
            api.ui.dialog.replace(() => <ImportFolderDialog api={api} status={st} />)
            return
          }
          if (st.lobby) {
            api.ui.dialog.clear()
            api.ui.toast({
              message: "No project yet — say hi in the chat: Orynr suggests a project name, then creates it (in Docker when it's running)",
            })
            return
          }
          if (choice === st.mode) {
            api.ui.dialog.clear()
            api.ui.toast({ message: `${st.name} is already ${LABELS[choice]}` })
            return
          }
          if ((choice === "docker" || choice === "docker-shared") && !st.docker_available) {
            api.ui.dialog.clear()
            api.ui.toast({ variant: "error", message: "Docker Desktop isn't running — start it, then switch" })
            return
          }
          switchTo(api, st, choice)
        }}
      />
    ))
  })()
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "sandbox.toggle",
        title: "Sandbox: Docker / Docker shared local / Local",
        description: "Choose how this project runs, copy a folder into it, or open another project folder",
        slashName: "sandbox",
        category: "System",
        namespace: "palette",
        run() {
          show(api)
        },
      },
    ],
    bindings: [],
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
