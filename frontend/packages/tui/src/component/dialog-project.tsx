import { Show } from "solid-js"
import path from "path"
import { useSDK } from "../context/sdk"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useRoute } from "../context/route"
import { useProject } from "../context/project"
import { refreshServerConfig } from "../context/sync"
import { useTuiPaths } from "../context/runtime"
import { useTheme } from "../context/theme"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { engineGet, enginePost } from "./engine-call"

// "Choose a project folder" - shown when Orynr Code opens and on every /new (Sai, 2026-10-03: in a terminal the user
// must always know, and choose, which folder the AI works in). A new project goes in the projects folder (in Docker
// when it is running, otherwise a local folder); a recent project or any folder on this PC opens where it is; "decide
// later" starts in the projects folder and Orynr asks for a name in the chat. The engine does the work
// (GET /projects, POST /project/create, POST /project/open); this box only asks.
type Project = { name: string; path: string; mode: string; updated: number }
type Sandbox = {
  docker_installed?: boolean
  docker_available?: boolean
  projects_root?: string
  project?: string
  name?: string
  lobby?: boolean
}
type Choice = { kind: "new" } | { kind: "open"; path: string } | { kind: "browse" } | { kind: "later" } | { kind: "stay" }

const MODE_LABEL: Record<string, string> = { docker: "Docker", "docker-shared": "Docker shared local", local: "Local" }

function call<T>(sdk: ReturnType<typeof useSDK>, route: string, body?: unknown): Promise<T | undefined> {
  return body === undefined ? engineGet<T>(sdk, route) : enginePost<T>(sdk, route, body)
}

// The data is loaded BEFORE the box opens (openProjectPicker): a box that loads its own data in onMount was rebuilt
// by the dialog every time it resized, so it reloaded forever and sat on "Loading your projects..." (2026-10-03).
export async function openProjectPicker(sdk: ReturnType<typeof useSDK>, dialog: ReturnType<typeof useDialog>) {
  const [list, sb] = await Promise.all([
    call<{ projects: Project[] }>(sdk, "/projects"),
    call<Sandbox>(sdk, "/sandbox"),
  ])
  const data = { projects: list?.projects ?? [], sandbox: sb ?? {} }
  dialog.replace(() => <DialogProject projects={data.projects} sandbox={data.sandbox} />)
}

export function DialogProject(props: { projects: Project[]; sandbox: Sandbox }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const route = useRoute()
  const project = useProject()
  const paths = useTuiPaths()
  const { theme } = useTheme()
  const projects = () => props.projects
  const sandbox = () => props.sandbox

  async function openFolder(dir: string, note?: string) {
    sdk.setDirectory(dir)
    await Promise.all([refreshServerConfig(), project.sync()]).catch(() => {})
    route.navigate({ type: "home" })
    dialog.clear()
    toast.show({ variant: "info", message: note ? `Project folder: ${dir} - ${note}` : `Project folder: ${dir}` })
  }

  function dockerNote(): string {
    const sb = sandbox()
    if (!sb.docker_installed) return "Docker is not installed, using a local project folder"
    if (!sb.docker_available) return "Docker isn't running, using a local project folder"
    return "runs in Docker (internet only)"
  }

  function askName() {
    dialog.replace(() => (
      <DialogPrompt
        title="Name the new project"
        description={() => (
          <text fg={theme.textMuted} wrapMode="word">
            A new folder in {sandbox().projects_root ?? "your projects folder"} - {dockerNote()}.
          </text>
        )}
        placeholder="my-game"
        onConfirm={(value) => {
          const name = value.trim()
          if (!name) return
          void (async () => {
            const res = await call<{ ok?: boolean; path?: string; error?: string; mode?: string }>(
              sdk,
              "/project/create",
              { name },
            )
            if (!res?.ok || !res.path) {
              toast.show({ variant: "error", message: res?.error ?? "Couldn't create the project" })
              return
            }
            await openFolder(res.path, MODE_LABEL[res.mode ?? "local"] ?? res.mode)
          })()
        }}
      />
    ))
  }

  function askPath() {
    dialog.replace(() => (
      <DialogPrompt
        title="Open a folder on this PC"
        description={() => (
          <text fg={theme.textMuted} wrapMode="word">
            Paste the path of a folder you already have. Orynr works in it where it is - nothing is moved or copied.
          </text>
        )}
        value={paths.home}
        placeholder={paths.home}
        onConfirm={(value) => {
          const raw = value.trim().replace(/^["']+|["']+$/g, "")
          if (!raw) return
          const folder = path.resolve(raw.startsWith("~") ? path.join(paths.home, raw.slice(1)) : raw)
          void (async () => {
            const res = await call<{ ok?: boolean; path?: string; error?: string; needs_trust?: boolean }>(
              sdk,
              "/project/open",
              { path: folder },
            )
            if (!res?.ok || !res.path) {
              toast.show({ variant: "error", message: res?.error ?? `Couldn't open ${folder}` })
              return
            }
            await openFolder(
              res.path,
              res.needs_trust ? "it has its own instruction files: /trust loads them if you trust it" : undefined,
            )
          })()
        }}
      />
    ))
  }

  return (
    <Show when={projects()}>
      <DialogSelect<Choice>
        title="Choose a project folder"
        options={[
          ...(sandbox().lobby === false && sandbox().project
            ? [
                {
                  title: `Continue in ${sandbox().name ?? "this project"}`,
                  value: { kind: "stay" } as Choice,
                  description: sandbox().project,
                },
              ]
            : []),
          {
            title: "New project",
            value: { kind: "new" },
            description: `a new folder in ${sandbox().projects_root ?? "your projects folder"}`,
            details: [dockerNote()],
          },
          ...(projects() ?? [])
            .filter((p) => p.path !== sandbox().project)
            .slice(0, 8)
            .map((p) => ({
            title: p.name,
            value: { kind: "open" as const, path: p.path },
            description: p.path,
            footer: MODE_LABEL[p.mode] ?? p.mode,
            category: "Recent projects",
          })),
          {
            title: "Another folder on this PC",
            value: { kind: "browse" },
            description: "paste the path of a folder you already have",
          },
          {
            title: "Decide later",
            value: { kind: "later" },
            description: "start in the projects folder - Orynr asks for a project name in the chat",
          },
        ]}
        onSelect={(option) => {
          const choice = option.value
          if (choice.kind === "new") return askName()
          if (choice.kind === "browse") return askPath()
          if (choice.kind === "open") {
            void openFolder(choice.path)
            return
          }
          if (choice.kind === "stay") {
            route.navigate({ type: "home" })
          }
          dialog.clear()
        }}
      />
    </Show>
  )
}
