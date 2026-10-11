import { createMemo, createSignal, onMount } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"

// The "Running apps" panel: lists dev servers started by run_app, with one-key open-in-browser,
// view-logs, and stop. Data comes from the engine's /preview endpoints (fetched on open + after a
// stop). Enter or `o` opens the app's URL in the user's browser; `l` shows recent logs; ctrl+d stops.
type App = { id: string; kind: string; status: string; url?: string | null; command: string }

const NONE = "__orynr_no_apps__"

export function DialogPreview() {
  const sdk = useSDK()
  const dialog = useDialog()
  const [apps, setApps] = createSignal<App[]>([])

  async function refresh() {
    try {
      const res = await sdk.fetch(`${sdk.url}/preview`)
      setApps((await res.json()) as App[])
    } catch {
      setApps([])
    }
  }
  onMount(refresh)

  const options = createMemo(() => {
    const list = apps()
    if (list.length === 0) {
      return [{ value: NONE, title: "(no apps running)",
                description: "start one with run_app (or ask the agent to run/preview your app)", category: undefined }]
    }
    return list.map((a) => ({
      value: a.id,
      title: `${a.kind}  ${a.url ?? "(starting…)"}`,
      description: `${a.status}  ·  ${a.command}`,
      category: undefined,
    }))
  })

  const actions = createMemo(() => [
    {
      command: "dialog.preview.open",
      title: "open",
      onTrigger: async (o: DialogSelectOption<string>) => {
        if (o.value === NONE) return
        try {
          await sdk.fetch(`${sdk.url}/preview/${o.value}/open`, { method: "POST" })
        } catch (error) {
          console.error("Failed to open app:", error)
        }
      },
    },
    {
      command: "dialog.preview.logs",
      title: "logs",
      onTrigger: async (o: DialogSelectOption<string>) => {
        if (o.value === NONE) return
        let text = "(no logs)"
        try {
          const res = await sdk.fetch(`${sdk.url}/preview/${o.value}/logs`)
          const j = (await res.json()) as { logs?: string }
          text = (j.logs || "").split("\n").slice(-25).join("\n") || "(no logs)"
        } catch (error) {
          text = `failed to read logs: ${error}`
        }
        await DialogConfirm.show(dialog, "App logs (recent)", text)
        dialog.replace(() => <DialogPreview />)
      },
    },
    {
      command: "dialog.preview.stop",
      title: "stop",
      onTrigger: async (o: DialogSelectOption<string>) => {
        if (o.value === NONE) return
        try {
          await sdk.fetch(`${sdk.url}/preview/${o.value}/stop`, { method: "POST" })
        } catch (error) {
          console.error("Failed to stop app:", error)
        }
        await refresh()
        dialog.replace(() => <DialogPreview />)
      },
    },
  ])

  return (
    <DialogSelect
      title="Running apps"
      options={options()}
      actions={actions()}
      onSelect={(option) => {
        // Enter opens the app in the browser (same as the `open` action).
        if (option.value !== NONE) void sdk.fetch(`${sdk.url}/preview/${option.value}/open`, { method: "POST" })
      }}
    />
  )
}
