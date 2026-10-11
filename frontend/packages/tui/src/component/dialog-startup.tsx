import { TextAttributes } from "@opentui/core"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useDialog } from "../ui/dialog"
import { useBindings } from "../keymap"
import { Spinner } from "./spinner"
import { engineGet } from "./engine-call"

// Shown at startup while the engine gets its services ready - connecting the switched-on MCP servers and having a
// self-hosted model server pre-read Orynr's instructions - so nobody is left wondering what is going on (Sai,
// 2026-10-03). The engine reports each stage at GET /global/ready. When it is done the box says so; Esc (or Enter)
// closes it at any time - a message sent before it is done just waits its turn. The wording stays deliberately plain
// (Sai, 2026-10-03): one "please wait" line, then "ready" - the engine's stage details are not shown.
export type Readiness = { ready: boolean; stage: string; message: string }

export async function fetchReadiness(sdk: ReturnType<typeof useSDK>): Promise<Readiness | undefined> {
  const r = await engineGet<Readiness>(sdk, "/global/ready")
  return r && typeof r.ready === "boolean" ? r : undefined
}

export function DialogStartup(props: { initial: Readiness }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const { theme } = useTheme()
  const [state, setState] = createSignal<Readiness>(props.initial)

  onMount(() => {
    const timer = setInterval(async () => {
      if (state().ready) return
      const next = await fetchReadiness(sdk)
      if (next) setState(next)
    }, 700)
    onCleanup(() => clearInterval(timer))
  })

  useBindings(() => ({
    bindings: [{ key: "return", desc: "Close", group: "Dialog", cmd: () => dialog.clear() }],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {state().ready ? "Ready" : "Please wait"}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show
        when={state().ready}
        fallback={
          <box paddingBottom={1}>
            <Spinner>{"Please wait while we get our services ready."}</Spinner>
          </box>
        }
      >
        <box paddingBottom={1}>
          <text fg={theme.success}>{"Ready. Press Esc to use Orynr Code."}</text>
        </box>
      </Show>
    </box>
  )
}
