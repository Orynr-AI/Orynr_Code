import type { TuiPlugin, TuiPluginApi } from "@orynr-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { refreshServerConfig } from "../../context/sync"

// In-console `/permission` command: cycles the global permission mode, INDEPENDENT of the current
// agent — you can be on the autonomous agent and flip to "Ask Before" to make it prompt, without
// leaving that agent. The engine gate (permission/permission.py) reads `config.permission` on EVERY
// tool call, so a switch applies to the next action with no restart. The three values are what the
// gate already understands; only the display names are friendly:
//   "allow" -> Full access    (no limits: works anywhere on the PC without asking; confirmed after a warning)
//   "ask"   -> Ask Before     (asks before each change; stays in the project folder - reading outside it needs
//                              one approval per chat, changing anything outside it is blocked)
//   "deny"  -> Auto Decline   (blocks every action)
const id = "internal:permission-mode"

// The generated SDK config type doesn't model `permission` as a plain string union here, so the
// update payload is cast — same approach the sandbox plugin uses for its `sandbox` block.
type WithPermission = { permission?: unknown }

const MODES: { value: "allow" | "ask" | "deny"; label: string; hint: string }[] = [
  { value: "allow", label: "Full access", hint: "works anywhere on this PC without asking" },
  { value: "ask", label: "Ask Before", hint: "asks before each change; stays in the project folder" },
  { value: "deny", label: "Auto Decline", hint: "blocks every action" },
]

function indexOfCurrent(perm: unknown): number {
  return MODES.findIndex((m) => m.value === perm) // -1 when unset / anything else
}

function label(perm: unknown): string {
  const i = indexOfCurrent(perm)
  return i === -1 ? "Ask Before (default: changes ask, stays in the project folder)" : MODES[i].label
}

// Shown before Full access is switched on (Sai, 2026-10-01: some people trust the AI fully - they get the option,
// with a warning that it is their responsibility).
const FULL_ACCESS_WARNING =
  "With Full access the AI works anywhere on this PC without asking you first: it can read, change, move and " +
  "delete files and run any command, inside or outside the project folder.\n\n" +
  "AI can make mistakes. It is your responsibility to make sure nothing important gets lost - back up your files " +
  "before you turn this on.\n\nSwitch to Ask Before at any time with /permission."

async function cycle(api: TuiPluginApi) {
  const current = (api.state.config as unknown as WithPermission).permission
  const i = indexOfCurrent(current)
  const next = MODES[i === -1 ? 1 : (i + 1) % MODES.length] // unset -> start at "Ask Before"
  if (next.value === "allow") {
    api.ui.dialog.replace(() => (
      <api.ui.DialogConfirm
        title="Turn on Full access?"
        message={FULL_ACCESS_WARNING}
        onCancel={() => api.ui.dialog.clear()}
        onConfirm={() => {
          api.ui.dialog.clear()
          void apply(api, next)
        }}
      />
    ))
    return
  }
  await apply(api, next)
}

async function apply(api: TuiPluginApi, next: (typeof MODES)[number]) {
  try {
    await api.client.global.config.update({ config: { permission: next.value } as never })
    // Config has no push event — refetch so api.state.config (and the next cycle) see the new value.
    await refreshServerConfig()
    api.ui.toast({ message: `Permission → ${next.label} — ${next.hint}` })
  } catch {
    api.ui.toast({ variant: "error", message: "Failed to change permission mode" })
  }
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "permission.cycle",
        title: "Permission: cycle (Ask Before → Auto Decline → Full access)",
        description: "Switch the permission mode — works while staying on any agent",
        slashName: "permission",
        category: "System",
        namespace: "palette",
        run() {
          void cycle(api)
        },
      },
      {
        name: "permission.show",
        title: "Permission: show current mode",
        description: "Show the current permission mode without changing it",
        slashName: "permission-status",
        category: "System",
        namespace: "palette",
        run() {
          const current = (api.state.config as unknown as WithPermission).permission
          api.ui.toast({ message: `Permission: ${label(current)}  (/permission to change)` })
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
