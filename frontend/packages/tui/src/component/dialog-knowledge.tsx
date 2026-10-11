import { Show } from "solid-js"
import { spawn } from "child_process"
import { useSDK } from "../context/sdk"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { DialogSelect } from "../ui/dialog-select"
import { engineGet } from "./engine-call"

// /knowledge - where the knowledge base is and what is in it (Sai, 2026-10-03: "no info on how it works or where to
// put what"). The engine owns it (families/knowledge.py, GET /knowledge): drop files in the folder and Orynr searches
// them when a question may be answered by them; its notes, journal and index are kept encrypted.
type Info = { folder: string; files: number; names: string[]; notes: number; journal: number }

// Loaded before the box opens (see openProjectPicker for why).
export async function openKnowledge(sdk: ReturnType<typeof useSDK>, dialog: ReturnType<typeof useDialog>) {
  const got = await engineGet<Info>(sdk, "/knowledge")
  const info = got && got.folder ? got : { folder: "(the engine didn't answer)", files: 0, names: [], notes: 0, journal: 0 }
  dialog.replace(() => <DialogKnowledge info={info} />)
}

export function DialogKnowledge(props: { info: Info }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const info = () => props.info

  function openFolder(folder: string) {
    const cmd = process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open"
    try {
      spawn(cmd, [folder], { detached: true, stdio: "ignore" }).unref()
    } catch {}
    dialog.clear()
  }

  return (
    <Show when={info()}>
      <DialogSelect<"open" | "close">
        title="Knowledge base"
        options={[
          {
            title: "Open the folder",
            value: "open",
            description: info()!.folder,
            details: [
              "Put your own documents here: notes, specs, manuals, PDFs, Word, Excel, PowerPoint, text, code.",
              "Orynr notices new and changed files by itself and searches them when a question may be answered by them.",
              `Now: ${info()!.files} file(s), ${info()!.notes} note(s), ${info()!.journal} journal entr(y/ies).`,
              ...(info()!.names.length ? ["Files: " + info()!.names.slice(0, 8).join(", ") + (info()!.files > 8 ? ", ..." : "")] : []),
              "Orynr's notes, journal and search index are kept encrypted; your files are never changed.",
            ],
          },
          { title: "Close", value: "close", description: "back to the chat" },
        ]}
        onSelect={(option) => {
          if (option.value === "open") return openFolder(info()!.folder)
          dialog.clear()
        }}
      />
    </Show>
  )
}
