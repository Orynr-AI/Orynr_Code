import { useSDK } from "../context/sdk"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { engineGet, enginePost } from "./engine-call"

// /keys - keys and addresses the built-in tools need (an MQTT broker, a Home Assistant token, a database address),
// saved in Orynr's encrypted vault by NAME (2.2.1). Tools read them by that name, so a password never goes through
// the chat; the AI tells the user which name to save when one is missing. Only names come back from the engine.
type Reply = { ok?: boolean; error?: string }

const EXAMPLES = "e.g. MQTT_HOST, MQTT_USER, MQTT_PASSWORD, HASS_URL, HASS_TOKEN, HUE_BRIDGE_IP, HUE_USERNAME"

export async function openKeys(sdk: ReturnType<typeof useSDK>, dialog: ReturnType<typeof useDialog>,
                               toast: ReturnType<typeof useToast>) {
  const got = await engineGet<{ names?: string[] }>(sdk, "/secrets")
  const names = got?.names ?? []

  async function save(name?: string) {
    const typed = name ?? (await DialogPrompt.show(dialog, "Name of the key", { placeholder: EXAMPLES }))
    if (!typed?.trim()) return openKeys(sdk, dialog, toast)
    const value = await DialogPrompt.show(dialog, `Value for ${typed.trim()}`, {
      placeholder: "the address, user name, token or password",
    })
    if (!value?.trim()) return openKeys(sdk, dialog, toast)
    const r = await enginePost<Reply>(sdk, "/secret/save", { name: typed.trim(), value })
    if (r?.ok) toast.show({ variant: "success", message: `Saved ${typed.trim()} (encrypted)`, duration: 3000 })
    else toast.show({ variant: "error", message: r?.error ?? "The engine didn't answer", duration: 5000 })
    return openKeys(sdk, dialog, toast)
  }

  function manage(name: string) {
    dialog.replace(() => (
      <DialogSelect<"replace" | "remove" | "back">
        title={name}
        options={[
          { title: "Replace the value", value: "replace" },
          { title: "Remove it", value: "remove" },
          { title: "Back", value: "back" },
        ]}
        onSelect={async (option) => {
          if (option.value === "replace") return save(name)
          if (option.value === "remove") {
            await enginePost<Reply>(sdk, "/secret/remove", { name })
            toast.show({ variant: "info", message: `Removed ${name}`, duration: 3000 })
          }
          return openKeys(sdk, dialog, toast)
        }}
      />
    ))
  }

  dialog.replace(() => (
    <DialogSelect<string>
      title="Saved keys"
      options={[
        {
          title: "Save a key",
          value: "\u0000new",
          description: "kept encrypted; the AI only ever sees the name",
          details: [
            "Built-in tools that talk to other things read their settings from here by name - " + EXAMPLES + ".",
            "When one is missing, Orynr tells you the exact name to save. Never paste a password into the chat.",
            "A database or web API key can be saved under any name and used as vault:NAME.",
          ],
        },
        ...names.map((n) => ({ title: n, value: n, description: "saved - select to replace or remove" })),
      ]}
      onSelect={(option) => {
        if (option.value === "\u0000new") return void save()
        manage(option.value)
      }}
    />
  ))
}
