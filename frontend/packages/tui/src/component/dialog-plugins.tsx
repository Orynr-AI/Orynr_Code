import { useSDK } from "../context/sdk"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { DialogSelect } from "../ui/dialog-select"
import { engineGet, enginePost } from "./engine-call"

// /plugins (3.1.1) - add-ons that change how Orynr works: the built-in ones (all off until switched on here) and the
// person's own .py files dropped into a plugins folder. Selecting one switches it on or off; it takes effect on the
// next step. Settings live in orynr.json under plugin_settings.<id>.
type Plugin = {
  id: string
  title: string
  description: string
  audience: string
  kind: "built-in" | "yours" | "settings"
  enabled: boolean
  error?: string | null
}
type Catalog = { plugins?: Plugin[]; folders?: string[]; ok?: boolean; error?: string }

const ADD = "\u0000add"

export async function openPlugins(sdk: ReturnType<typeof useSDK>, dialog: ReturnType<typeof useDialog>,
                                  toast: ReturnType<typeof useToast>) {
  const got = await engineGet<Catalog>(sdk, "/plugin/catalog")
  if (!got?.plugins) {
    toast.show({ variant: "error", message: "The engine didn't answer - try again in a moment", duration: 4000 })
    return
  }
  const folders = got.folders ?? []

  async function flip(p: Plugin) {
    const r = await enginePost<Catalog>(sdk, "/plugin/toggle", { id: p.id, enabled: !p.enabled })
    if (r?.ok) toast.show({ variant: "success", message: `${p.title} is ${p.enabled ? "off" : "on"}`, duration: 2500 })
    else toast.show({ variant: "error", message: r?.error ?? "The engine didn't answer", duration: 4000 })
    return openPlugins(sdk, dialog, toast)
  }

  const row = (p: Plugin) => ({
    title: `${p.enabled ? "[on] " : "[off]"} ${p.title}`,
    value: p.id,
    category: p.kind === "built-in" ? "Built-in" : "Your plugins",
    description: p.error ? "failed to load - see details" : p.audience === "developers" ? "for developers" : "",
    details: [p.description, ...(p.error ? [`Error: ${p.error}`] : []), p.enabled ? "Select to switch off." : "Select to switch on."],
  })

  const plugins = got.plugins
  dialog.replace(() => (
    <DialogSelect<string>
      title="Plugins"
      options={[
        ...plugins.filter((p) => p.kind !== "settings").map(row),
        {
          title: "Add your own plugin",
          value: ADD,
          category: "Your plugins",
          description: "a .py file in a plugins folder",
          details: [
            "A plugin is a small Python file that changes how Orynr works: add a tool, block or allow actions, "
              + "change a command's input or output, or react when a job finishes.",
            ...folders.map((f, i) => (i === 0 ? `This project only: ${f}` : `Every project: ${f}`)),
            "Ask Orynr \"how do I write a plugin?\" for an example. A new file is on straight away.",
          ],
        },
      ]}
      onSelect={(option) => {
        if (option.value === ADD) {
          toast.show({ variant: "info", message: `Put your .py file in ${folders[folders.length - 1] ?? "the plugins folder"}`,
                       duration: 6000 })
          return
        }
        const p = plugins.find((x) => x.id === option.value)
        if (p && p.kind !== "settings") void flip(p)
      }}
    />
  ))
}
