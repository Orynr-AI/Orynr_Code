import { createMemo, createSignal, onMount, Show } from "solid-js"
import { useSync } from "../context/sync"
import { map, pipe, sortBy } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Link } from "../ui/link"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@orynr-ai/sdk/v2"
import { DialogModel } from "./dialog-model"
import { useToast } from "../ui/toast"
import { isConsoleManagedProvider } from "../util/provider-origin"
import { useConnected } from "./use-connected"
import { useBindings } from "../keymap"
import { useClipboard } from "../context/clipboard"

const PROVIDER_PRIORITY: Record<string, number> = {
  openai: 2,
  "github-copilot": 3,
  anthropic: 4,
  google: 5,
  deepseek: 6,
  xai: 7, // Grok
  openrouter: 8, // aggregator / router
  groq: 9,
  mistral: 10,
}

// Self-hosted servers (llama.cpp, vLLM, LM Studio, Ollama...) are all added through the one "Local or network
// server" entry, by address. Catalog presets for them and servers already set up are not listed here: the
// preset would only duplicate that entry, and a configured server belongs in the model picker (adding the same
// address again updates it).
const SELF_HOSTED = new Set(["local", "lmstudio", "vllm", "llamacpp", "ollama"])

// WHITELIST: the picker shows ONLY these providers — the models.dev catalog carries ~150,
// which is noise for a local-first product. Anything already connected/configured is also
// kept, so a provider you use never disappears. Everything else is hidden.
// Additional connectable cloud providers + routers/gateways to surface in the picker (shown under
// the "Providers" heading). The models.dev catalog carries ~150; these are the ones worth offering
// alongside the ranked "Popular" set above without dumping the whole list.
const INCLUDED_EXTRA = new Set<string>([
  "vercel", // AI Gateway (router)
  "requesty", // router
  "cerebras",
  "fireworks-ai",
  "deepinfra",
  "perplexity",
  "cohere",
  "baseten",
  "nebius",
  "moonshotai", // Kimi
  "alibaba", // Qwen
  "amazon-bedrock",
  "azure",
])

const INCLUDED_PROVIDERS = new Set<string>([...Object.keys(PROVIDER_PRIORITY), ...INCLUDED_EXTRA])

const LOCAL_SERVER_OPTION_VALUE = "__orynr_local_server__"

type ProviderOptionBase = {
  title: string
  value: string
  description?: string
  category: string
}

type ProviderOption =
  | (ProviderOptionBase & {
      type: "provider"
      providerID: string
    })
  | (ProviderOptionBase & {
      type: "server"
    })

type ListedProvider = { id: string; name: string; options?: { baseURL?: unknown } }

// A server on this PC or the network: a self-hosted preset, or anything the engine reports with its own address.
function isSelfHosted(provider: ListedProvider) {
  return SELF_HOSTED.has(provider.id) || Boolean(provider.options?.baseURL)
}

export function providerOptions(list: ListedProvider[], connected: string[] = []): ProviderOption[] {
  const keep = new Set(connected)
  const listed: ProviderOption[] = [
    ...pipe(
      list.filter((x) => !isSelfHosted(x) && (INCLUDED_PROVIDERS.has(x.id) || keep.has(x.id))),
      sortBy(
        (x) => PROVIDER_PRIORITY[x.id] ?? 99,
        (x) => x.name.toLowerCase(),
        (x) => x.id,
      ),
      map((provider) => ({
        type: "provider" as const,
        title: provider.name,
        value: provider.id,
        providerID: provider.id,
        description: {
          anthropic: "(API key)",
          openai: "(ChatGPT Plus/Pro or API key)",
          deepseek: "(API key)",
        }[provider.id],
        category: provider.id in PROVIDER_PRIORITY ? "Popular" : "Providers",
      })),
    ),
  ]
  const server: ProviderOption = {
    type: "server",
    title: "Local or network server",
    value: LOCAL_SERVER_OPTION_VALUE,
    description: "(llama.cpp, vLLM, LM Studio, Ollama - by address)",
    category: "Self-hosted",
  }
  // First in the list: this is a local-first product, and below the nine Popular clouds nobody found it.
  return [server, ...listed]
}

export function createDialogProviderOptions() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const onboarded = useConnected()

  // The generated SDK has no method for this engine route; its underlying client still adds the base URL.
  type RawPost = (options: { url: string; body?: unknown; headers?: Record<string, string> }) => Promise<{
    data?: unknown
    error?: unknown
  }>
  type AddReply = { ok?: boolean; error?: string; providerID?: string; name?: string; models?: { id: string }[] }

  async function ask(title: string, placeholder: string, hint: string, value?: string) {
    return DialogPrompt.show(dialog, title, {
      placeholder,
      value,
      description: () => <text fg={theme.textMuted}>{hint}</text>,
    })
  }

  // Ask for the address, a name and an optional key, have the engine check the server, and only then save it.
  // A wrong address or key brings the address prompt back with what was typed, and says what went wrong.
  async function addLocalServer(previous?: { url: string; name: string }): Promise<void> {
    const url = await ask(
      "Server address",
      "http://192.168.1.50:8080",
      "A llama.cpp, vLLM, LM Studio or Ollama server on this PC or your network. The /v1 part is optional.",
      previous?.url,
    )
    if (url === null || !url.trim()) return
    const name = await ask("Name", "My GPU server", "What to call it in the model list. Leave empty to use the address.",
      previous?.name)
    if (name === null) return
    const key = await ask("API key", "leave empty if the server has none",
      "Only if the server was started with a key (llama.cpp --api-key). Stored encrypted, never in orynr.json.")
    if (key === null) return

    dialog.replace(() => <DialogPrompt title="Checking the server" value={url.trim()} busy busyText="Asking it for its models..." />)
    let reply: AddReply
    try {
      const post = (sdk.client as unknown as { client: { post: RawPost } }).client.post
      const result = await post({
        url: "/provider/local",
        body: { url: url.trim(), name: name.trim(), apiKey: key.trim() || undefined },
        headers: { "Content-Type": "application/json" },
      })
      reply = ((result.data ?? result.error) as AddReply) ?? { ok: false, error: "No answer from the engine." }
    } catch (err) {
      reply = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    if (!reply.ok || !reply.providerID) {
      toast.show({ variant: "error", message: reply.error ?? "The server could not be added.", duration: 8000 })
      return addLocalServer({ url: url.trim(), name: name.trim() })
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    const count = reply.models?.length ?? 0
    toast.show({
      variant: "success",
      message: `Added ${reply.name ?? reply.providerID} - ${count} model${count === 1 ? "" : "s"}. Pick one to use it.`,
    })
    const providerID = reply.providerID
    dialog.replace(() => <DialogModel providerID={providerID} />)
  }

  const options = createMemo(() => {
    return pipe(
      providerOptions(sync.data.provider_next.all, sync.data.provider_next.connected),
      map((provider) => {
        if (provider.type === "server") {
          return {
            title: provider.title,
            value: provider.value,
            description: provider.description,
            category: provider.category,
            async onSelect() {
              await addLocalServer()
            },
          }
        }

        const providerID = provider.providerID
        const consoleManaged = isConsoleManagedProvider(sync.data.console_state.consoleManagedProviders, providerID)
        const connected = sync.data.provider_next.connected.includes(providerID)

        return {
          title: provider.title,
          value: provider.value,
          description: provider.description,
          footer: consoleManaged ? sync.data.console_state.activeOrgName : undefined,
          category: provider.category,
          gutter: connected && onboarded() ? () => <text fg={theme.success}>✓</text> : undefined,
          async onSelect() {
            if (consoleManaged) return

            const methods = sync.data.provider_auth[providerID] ?? [
              {
                type: "api",
                label: "API key",
              },
            ]
            let index: number | null = 0
            if (methods.length > 1) {
              index = await new Promise<number | null>((resolve) => {
                dialog.replace(
                  () => (
                    <DialogSelect
                      title="Select auth method"
                      options={methods.map((x, index) => ({
                        title: x.label,
                        value: index,
                      }))}
                      onSelect={(option) => resolve(option.value)}
                    />
                  ),
                  () => resolve(null),
                )
              })
            }
            if (index == null) return
            const method = methods[index]
            if (method.type === "oauth") {
              let inputs: Record<string, string> | undefined
              if (method.prompts?.length) {
                const value = await PromptsMethod({
                  dialog,
                  prompts: method.prompts,
                })
                if (!value) return
                inputs = value
              }

              const result = await sdk.client.provider.oauth.authorize({
                providerID,
                method: index,
                inputs,
              })
              if (result.error) {
                toast.show({
                  variant: "error",
                  message: JSON.stringify(result.error),
                })
                dialog.clear()
                return
              }
              if (result.data?.method === "code") {
                dialog.replace(() => (
                  <CodeMethod providerID={providerID} title={method.label} index={index} authorization={result.data!} />
                ))
              }
              if (result.data?.method === "auto") {
                dialog.replace(() => (
                  <AutoMethod providerID={providerID} title={method.label} index={index} authorization={result.data!} />
                ))
              }
            }
            if (method.type === "api") {
              let metadata: Record<string, string> | undefined
              if (method.prompts?.length) {
                const value = await PromptsMethod({ dialog, prompts: method.prompts })
                if (!value) return
                metadata = value
              }
              return dialog.replace(() => (
                <ApiMethod providerID={providerID} title={method.label} metadata={metadata} />
              ))
            }
          },
        }
      }),
    )
  })
  return options
}

export function DialogProvider() {
  const options = createDialogProviderOptions()
  return <DialogSelect title="Connect a provider" options={options()} />
}

interface AutoMethodProps {
  index: number
  providerID: string
  title: string
  authorization: ProviderAuthAuthorization
}
function AutoMethod(props: AutoMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const dialog = useDialog()
  const sync = useSync()
  const toast = useToast()
  const clipboard = useClipboard()

  useBindings(() => ({
    bindings: [
      {
        key: "c",
        desc: "Copy provider code",
        group: "Dialog",
        cmd: () => {
          const code =
            props.authorization.instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)?.[0] ?? props.authorization.url
          clipboard
            .write?.(code)
            .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
            .catch(toast.error)
        },
      },
    ],
  }))

  onMount(async () => {
    const result = await sdk.client.provider.oauth.callback({
      providerID: props.providerID,
      method: props.index,
    })
    if (result.error) {
      toast.show({
        variant: "error",
        message:
          "name" in result.error && result.error.name === "ProviderAuthOauthCallbackFailed"
            ? "OAuth authorization failed. Try /connect again."
            : JSON.stringify(result.error),
      })
      dialog.clear()
      return
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    dialog.replace(() => <DialogModel providerID={props.providerID} />)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1}>
        <Link href={props.authorization.url} fg={theme.primary} />
        <text fg={theme.textMuted}>{props.authorization.instructions}</text>
      </box>
      <text fg={theme.textMuted}>Waiting for authorization...</text>
      <text fg={theme.text}>
        c <span style={{ fg: theme.textMuted }}>copy</span>
      </text>
    </box>
  )
}

interface CodeMethodProps {
  index: number
  title: string
  providerID: string
  authorization: ProviderAuthAuthorization
}
function CodeMethod(props: CodeMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const [error, setError] = createSignal(false)

  return (
    <DialogPrompt
      title={props.title}
      placeholder="Authorization code"
      onConfirm={async (value) => {
        const { error } = await sdk.client.provider.oauth.callback({
          providerID: props.providerID,
          method: props.index,
          code: value,
        })
        if (!error) {
          await sdk.client.instance.dispose()
          await sync.bootstrap()
          dialog.replace(() => <DialogModel providerID={props.providerID} />)
          return
        }
        setError(true)
      }}
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>{props.authorization.instructions}</text>
          <Link href={props.authorization.url} fg={theme.primary} />
          <Show when={error()}>
            <text fg={theme.error}>Invalid code</text>
          </Show>
        </box>
      )}
    />
  )
}

interface ApiMethodProps {
  providerID: string
  title: string
  metadata?: Record<string, string>
}
function ApiMethod(props: ApiMethodProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const { theme } = useTheme()

  return (
    <DialogPrompt
      title={props.title}
      placeholder="API key"
      onConfirm={async (value) => {
        if (!value) return
        await sdk.client.auth.set({
          providerID: props.providerID,
          auth: {
            type: "api",
            key: value,
            ...(props.metadata ? { metadata: props.metadata } : {}),
          },
        })
        await sdk.client.instance.dispose()
        await sync.bootstrap()
        dialog.replace(() => <DialogModel providerID={props.providerID} />)
      }}
    />
  )
}

interface PromptsMethodProps {
  dialog: ReturnType<typeof useDialog>
  prompts: NonNullable<ProviderAuthMethod["prompts"]>[number][]
}
async function PromptsMethod(props: PromptsMethodProps) {
  const inputs: Record<string, string> = {}
  for (const prompt of props.prompts) {
    if (prompt.when) {
      const value = inputs[prompt.when.key]
      if (value === undefined) continue
      const matches = prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value
      if (!matches) continue
    }

    if (prompt.type === "select") {
      const value = await new Promise<string | null>((resolve) => {
        props.dialog.replace(
          () => (
            <DialogSelect
              title={prompt.message}
              options={prompt.options.map((x) => ({
                title: x.label,
                value: x.value,
                description: x.hint,
              }))}
              onSelect={(option) => resolve(option.value)}
            />
          ),
          () => resolve(null),
        )
      })
      if (value === null) return null
      inputs[prompt.key] = value
      continue
    }

    const value = await new Promise<string | null>((resolve) => {
      props.dialog.replace(
        () => (
          <DialogPrompt title={prompt.message} placeholder={prompt.placeholder} onConfirm={(value) => resolve(value)} />
        ),
        () => resolve(null),
      )
    })
    if (value === null) return null
    inputs[prompt.key] = value
  }
  return inputs
}
