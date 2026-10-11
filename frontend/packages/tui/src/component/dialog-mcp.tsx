import { createMemo, createSignal, onMount } from "solid-js"
import { useLocal } from "../context/local"
import { useSync } from "../context/sync"
import { map, pipe, entries, sortBy } from "remeda"
import { DialogSelect, type DialogSelectRef, type DialogSelectOption } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import { useSDK } from "../context/sdk"
import { useCommandShortcut } from "../keymap"
import { useToast } from "../ui/toast"
import { engineGet, enginePost } from "./engine-call"

const ADD_SERVER = "__orynr_add_mcp_server__"
const BUILTIN = "__orynr_builtin__:"

// Turn what the user typed into a command array. A lone .py path — even one with spaces — is sent as
// ONE element; the engine runs it with its own Python (mcp._normalize_command), so the user only has
// to paste the server file. Anything that starts with an interpreter, or isn't a .py path, is split
// on whitespace as a full command.
function toCommand(input: string): string[] {
  const s = input.trim()
  const bare = s.replace(/^["']|["']$/g, "")
  // A lone path to a server file or program - even with spaces in it - is ONE argument.
  if (!/\s-{1,2}\w/.test(bare) && /\.(py|exe|cmd|bat|js|mjs)$/i.test(bare) && !/^(python3?|py|node|npx|uvx)(\.exe)?\s/i.test(bare))
    return [bare]
  // Otherwise split like a shell: spaces separate arguments, quotes keep one together.
  const parts: string[] = []
  let current = ""
  let quote = ""
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = ""
      else current += ch
    } else if (ch === '"' || ch === "'") quote = ch
    else if (/\s/.test(ch)) {
      if (current) parts.push(current)
      current = ""
    } else current += ch
  }
  if (current) parts.push(current)
  return parts
}

function Status(props: { enabled: boolean; loading: boolean }) {
  const { theme } = useTheme()
  if (props.loading) {
    return <span style={{ fg: theme.textMuted }}>⋯ Loading</span>
  }
  if (props.enabled) {
    return <span style={{ fg: theme.success, attributes: TextAttributes.BOLD }}>✓ Enabled</span>
  }
  return <span style={{ fg: theme.textMuted }}>○ Disabled</span>
}

export function DialogMcp() {
  const local = useLocal()
  const sync = useSync()
  const sdk = useSDK()
  const dialog = useDialog()
  const { theme } = useTheme()
  const [, setRef] = createSignal<DialogSelectRef<unknown>>()
  const [loading, setLoading] = createSignal<string | null>(null)
  // Two-tap delete confirm (ctrl+d, then ctrl+d again on the same row) — matches the session list,
  // stash, and move-session dialogs. `toDelete` holds the armed server name.
  const [toDelete, setToDelete] = createSignal<string | null>(null)
  const deleteHint = useCommandShortcut("dialog.mcp.delete")

  const toast = useToast()

  // What used to be separate MCP servers (network monitor, Excel, home automation...) is built into Orynr since
  // 2.2.0 - always on, nothing to start. Listed here under its own heading so nobody thinks it is gone (Sai,
  // 2026-10-03: "what happened to all the other MCPs I had?").
  type Builtin = { name: string; description: string; tools: number; kind: string; optional?: boolean; enabled?: boolean }
  const [builtin, setBuiltin] = createSignal<Builtin[]>([])
  onMount(() => {
    void engineGet<{ items?: Builtin[] }>(sdk, "/builtin-tools").then((r) => setBuiltin(r?.items ?? []))
  })
  const isBuiltin = (value: string) => value.startsWith(BUILTIN)

  // MCP calls use /mcp/status and /mcp/add (same as /mcp): some Windows security software breaks local replies on
  // paths ending in "/mcp" (see orynr_server/mcp/mcp.py).
  async function refresh() {
    const status = await sdk.client.mcp.status(undefined, { url: "/mcp/status" } as never)
    if (status.data) sync.set("mcp", status.data)
  }

  // Connect an external MCP server: a web address (remote) or a program on this PC (local). The engine connects
  // and lists its tools BEFORE saving anything (POST /mcp/setup), keeps any key in the encrypted vault, and says
  // plainly what went wrong - the prompts then come back with what was typed.
  type Setup = { kind: "remote" | "local"; name: string; target: string; key: string }
  type SetupReply = { ok?: boolean; status?: string; error?: string; name?: string; tools?: string[] }

  async function ask(title: string, placeholder: string, hint: string, value?: string) {
    return DialogPrompt.show(dialog, title, {
      placeholder,
      value,
      description: () => <text fg={theme.textMuted}>{hint}</text>,
    })
  }

  async function choose<T extends string>(title: string, options: { title: string; value: T; description?: string }[]) {
    return new Promise<T | null>((resolve) => {
      dialog.replace(
        () => <DialogSelect title={title} options={options} onSelect={(option) => resolve(option.value as T)} />,
        () => resolve(null),
      )
    })
  }

  async function post(body: Record<string, unknown>): Promise<SetupReply> {
    try {
      const res = await sdk.fetch(`${sdk.url}/mcp/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      return (await res.json()) as SetupReply
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async function addServer(previous?: Setup): Promise<void> {
    const kind =
      previous?.kind ??
      (await choose<"remote" | "local">("Add an MCP server", [
        { title: "A web address (remote server)", value: "remote", description: "https://…/mcp" },
        { title: "A program on this PC (local server)", value: "local", description: "npx …, a server file, …" },
      ]))
    if (!kind) return dialog.replace(() => <DialogMcp />)
    const remote = kind === "remote"
    const target = await ask(
      remote ? "Server address" : "Command",
      remote ? "https://example.com/mcp" : "npx -y @modelcontextprotocol/server-github",
      remote
        ? "The MCP server's web address (it often ends in /mcp or /sse)."
        : "What starts the server: an npx/uvx command, or the path to a server file. Paths with spaces are fine.",
      previous?.target,
    )
    if (target === null || !target.trim()) return dialog.replace(() => <DialogMcp />)
    const name = await ask("Name", "e.g. github", "A short name - its tools appear as mcp__<name>__<tool>.", previous?.name)
    if (name === null || !name.trim()) return dialog.replace(() => <DialogMcp />)
    const key = await ask(
      remote ? "API key or token (optional)" : "Key it needs (optional)",
      remote ? "leave empty if none" : "e.g. GITHUB_TOKEN=ghp_…",
      remote
        ? 'Sent as "Authorization: Bearer <key>". To use another header, type it as "Header-Name: value". Stored encrypted.'
        : "For a program that reads its key from the environment: NAME=value. Stored encrypted, never in a settings file.",
    )
    if (key === null) return dialog.replace(() => <DialogMcp />)
    const setup: Setup = { kind, name: name.trim(), target: target.trim(), key: key.trim() }
    const body: Record<string, unknown> = {
      kind,
      name: setup.name,
      [remote ? "url" : "command"]: setup.target,
      key: setup.key || undefined,
    }

    dialog.replace(() => <DialogPrompt title="Connecting" value={setup.target} busy busyText="Connecting and listing its tools..." />)
    let reply = await post(body)
    if (!reply.ok && reply.status === "private") {
      const allow = await choose<"allow" | "cancel">("This server is on your own PC or network", [
        { title: "Allow it - it's mine", value: "allow", description: "connect to this one address" },
        { title: "Cancel", value: "cancel" },
      ])
      if (allow !== "allow") return dialog.replace(() => <DialogMcp />)
      dialog.replace(() => <DialogPrompt title="Connecting" value={setup.target} busy busyText="Connecting and listing its tools..." />)
      reply = await post({ ...body, allowPrivate: true })
    }
    if (!reply.ok) {
      toast.show({ variant: "error", message: reply.error ?? "The server could not be connected.", duration: 9000 })
      return addServer(setup)
    }
    await refresh()
    const count = reply.tools?.length ?? 0
    toast.show({
      variant: "success",
      message: `Connected ${reply.name} - ${count} tool${count === 1 ? "" : "s"}. Every agent can use them now.`,
    })
    dialog.replace(() => <DialogMcp />)
  }

  // Edit an existing server: change its NAME and its path/command (or URL). Prefills both from the
  // RESOLVED config (/mcp/servers merges config + registry + auto-discovered) — the plain /config
  // file omits registry-added and discovered servers, which is why edit used to show an empty field.
  async function editServer(name: string) {
    let current = ""
    let isRemote = false
    let existing: Record<string, unknown> = {}
    try {
      const res = await sdk.fetch(`${sdk.url}/mcp/servers`)
      const servers = (await res.json()) as Record<string, { type?: string; url?: string; command?: string[] }>
      const entry = servers?.[name]
      existing = { ...(entry ?? {}) }
      if (entry?.type === "remote") {
        isRemote = true
        current = String(entry.url ?? "")
      } else {
        current = Array.isArray(entry?.command) ? entry!.command!.join(" ") : ""
      }
    } catch (error) {
      console.error("Failed to read MCP config for edit:", error)
    }
    // 1) Name — prefilled with the current name so the user can rename in place.
    const rawName = await DialogPrompt.show(dialog, `Rename "${name}"`, {
      value: name,
      placeholder: "server name",
      description: () => (
        <text fg={theme.textMuted}>{"The server's name — tools appear as mcp__<name>__<tool>. Leave as-is to keep it."}</text>
      ),
    })
    if (rawName === null) return dialog.replace(() => <DialogMcp />) // esc = cancel the whole edit
    const newName = rawName.trim() || name
    // 2) Path/command (or URL), prefilled with the CURRENT value.
    const edited = await DialogPrompt.show(dialog, `Edit "${newName}"`, {
      value: current,
      placeholder: isRemote ? "https://…/mcp" : "C:\\path\\to\\server.py",
      description: () => (
        <text fg={theme.textMuted}>
          {isRemote ? "Remote MCP server URL." : "Path to your server .py (runs with the engine's Python), or a full command."}
        </text>
      ),
    })
    if (edited === null || !edited.trim()) return dialog.replace(() => <DialogMcp />)
    const config = isRemote
      ? { ...existing, type: "remote", url: edited.trim() }
      : { ...existing, type: "local", command: toCommand(edited) }
    try {
      // Save under the new name first, then remove the old entry (so a stored key it uses isn't deleted).
      await sdk.client.mcp.add({ name: newName, config: config as never }, { url: "/mcp/add" } as never)
      if (newName !== name) {
        await sdk.fetch(`${sdk.url}/mcp/remove`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        })
      }
      await refresh()
    } catch (error) {
      console.error("Failed to edit MCP server:", error)
    }
    dialog.replace(() => <DialogMcp />)
  }

  const options = createMemo(() => {
    // Track sync data, loading, and armed-delete state to trigger re-render when they change
    const mcpData = sync.data.mcp
    const loadingMcp = loading()
    const armed = toDelete()

    return [
      {
        value: ADD_SERVER,
        title: "+ Add a server",
        description: "a web address or a program on this PC",
        category: undefined,
      },
      ...pipe(
        mcpData ?? {},
        entries(),
        sortBy(([name]) => name),
        map(([name, status]) => {
          const arming = armed === name
          return {
            value: name,
            title: arming ? `Press ${deleteHint()} again to confirm` : name,
            bg: arming ? theme.error : undefined,
            description: arming ? undefined : status.status === "failed" ? "failed" : status.status,
            footer: arming ? undefined : <Status enabled={local.mcp.isEnabled(name)} loading={loadingMcp === name} />,
            category: builtin().length ? "MCP servers" : undefined,
          }
        }),
      ),
      // Optional ones (Blender) first, with an on/off switch like the MCP servers; the rest are always on.
      ...builtin()
        .filter((item) => item.optional)
        .map((item) => ({
          value: BUILTIN + item.name,
          title: item.name.replace(/_/g, " "),
          description: `${item.tools} tools · ${item.enabled ? "on" : "off - press space to switch on"} · ${item.description}`,
          footer: <Status enabled={!!item.enabled} loading={loadingMcp === BUILTIN + item.name} />,
          category: "Built into Orynr (switch on when you need it)",
        })),
      ...builtin()
        .filter((item) => !item.optional)
        .map((item) => ({
          value: BUILTIN + item.name,
          title: item.name.replace(/_/g, " "),
          description: `${item.tools} tools · ${item.description}`,
          category: item.kind === "family" ? "Built into Orynr (always on)" : "Built-in developer tools (always on)",
        })),
    ]
  })

  const actions = createMemo(() => [
    {
      command: "dialog.mcp.toggle",
      title: "toggle",
      onTrigger: async (option: DialogSelectOption<string>) => {
        if (option.value === ADD_SERVER) return // the synthetic "add" row isn't toggleable
        if (isBuiltin(option.value)) {
          const name = option.value.slice(BUILTIN.length)
          if (!builtin().find((item) => item.name === name)?.optional) return // always on
          setLoading(option.value)
          const r = await enginePost<{ ok?: boolean; enabled?: boolean }>(sdk, "/builtin-tools/toggle", { name })
          setLoading(null)
          if (r?.ok) {
            setBuiltin(builtin().map((item) => (item.name === name ? { ...item, enabled: r.enabled } : item)))
            toast.show({
              variant: "info",
              message: `${name} ${r.enabled ? "switched on" : "switched off"} - it applies from your next new chat`,
              duration: 4000,
            })
          }
          return
        }
        setToDelete(null) // any other action disarms a pending delete
        // Prevent toggling while an operation is already in progress
        if (loading() !== null) return

        setLoading(option.value)
        try {
          await local.mcp.toggle(option.value)
          // Refresh MCP status from server
          const status = await sdk.client.mcp.status(undefined, { url: "/mcp/status" } as never)
          if (status.data) {
            sync.set("mcp", status.data)
          } else {
            console.error("Failed to refresh MCP status: no data returned")
          }
        } catch (error) {
          console.error("Failed to toggle MCP:", error)
        } finally {
          setLoading(null)
        }
      },
    },
    {
      command: "dialog.mcp.edit",
      title: "edit",
      onTrigger: async (option: DialogSelectOption<string>) => {
        if (option.value === ADD_SERVER || isBuiltin(option.value)) return // nothing to edit
        setToDelete(null) // any other action disarms a pending delete
        await editServer(option.value)
      },
    },
    {
      command: "dialog.mcp.delete",
      title: "delete",
      onTrigger: async (option: DialogSelectOption<string>) => {
        if (option.value === ADD_SERVER || isBuiltin(option.value)) return // built-in tools can't be removed
        // Two-tap confirm (matches session list / stash / move-session): the first ctrl+d arms the
        // row (its title flips to "Press ctrl+d again to confirm"); a second ctrl+d on the SAME row
        // deletes. Moving the selection disarms it (see onMove). No modal dialog.
        if (toDelete() !== option.value) {
          setToDelete(option.value)
          return
        }
        setToDelete(null)
        try {
          await sdk.fetch(`${sdk.url}/mcp/remove`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: option.value }),
          })
          await refresh()
        } catch (error) {
          console.error("Failed to delete MCP server:", error)
        }
      },
    },
  ])

  return (
    <DialogSelect
      ref={setRef}
      title="MCPs"
      options={options()}
      actions={actions()}
      onMove={() => setToDelete(null)}
      onSelect={(option) => {
        // Only the "+ Add a server" row acts on select; the rest toggle via space, close via esc.
        if (option.value === ADD_SERVER) void addServer()
      }}
    />
  )
}
