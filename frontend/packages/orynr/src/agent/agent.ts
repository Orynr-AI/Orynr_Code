import { LayerNode } from "@orynr-ai/core/effect/layer-node"
import { PermissionV1 } from "@orynr-ai/core/v1/permission"
import { Config } from "@/config/config"
import { serviceUse } from "@orynr-ai/core/effect/service-use"
import { Provider } from "@/provider/provider"

import { generateObject, streamObject, type ModelMessage } from "ai"
import { Truncate } from "@/tool/truncate"
import { Auth } from "../auth"
import { ProviderTransform } from "@/provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import { Permission } from "@/permission"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@orynr-ai/core/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, Context, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { AbsolutePath, type DeepMutable } from "@orynr-ai/core/schema"
import { ProviderV2 } from "@orynr-ai/core/provider"
import { ModelV2 } from "@orynr-ai/core/model"
import { LocationServiceMap, locationServiceMapLayer } from "@orynr-ai/core/location-services"
import { Reference } from "@orynr-ai/core/reference"
import { Location } from "@orynr-ai/core/location"
import { PluginV2 } from "@orynr-ai/core/plugin"

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: PermissionV1.Ruleset,
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelV2.ID,
      providerID: ProviderV2.ID,
    }),
  ),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
  budget: Schema.optional(
    Schema.Struct({
      cost: Schema.optional(Schema.Finite),
      action: Schema.optional(Schema.Literals(["ask", "allow", "deny"])),
    }),
  ),
  confirmation: Schema.optional(Schema.Struct({ mode: Schema.optional(Schema.Literals(["never", "risky", "always"])) })),
  max_loops: Schema.optional(Schema.Finite),
}).annotate({ identifier: "Agent" })
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

const GeneratedAgent = Schema.Struct({
  identifier: Schema.String,
  whenToUse: Schema.String,
  systemPrompt: Schema.String,
})

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultInfo: () => Effect.Effect<Info>
  readonly defaultAgent: () => Effect.Effect<string>
  // Tier chokepoint for primary selection: resolves a requested primary name to an entitled
  // agent, falling back to the always-available switchboard (chat). See AUTONOMOUS-NATIVE-DESIGN §4.
  readonly resolvePrimary: (name: string | undefined) => Effect.Effect<Info>
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  }) => Effect.Effect<
    {
      identifier: string
      whenToUse: string
      systemPrompt: string
    },
    Provider.DefaultModelError
  >
}

type State = Omit<Interface, "generate">

export class Service extends Context.Service<Service, Interface>()("@orynr/Agent") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const skill = yield* Skill.Service
    const provider = yield* Provider.Service
    const locations = yield* LocationServiceMap.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Agent.state")(function* (ctx) {
        const cfg = yield* config.get()
        const skillDirs = yield* skill.dirs()
        const referenceDirs = Object.keys(cfg.references ?? cfg.reference ?? {}).length
          ? yield* Effect.gen(function* () {
              yield* (yield* PluginV2.Service).wait(PluginV2.ID.make("core/config-reference"))
              return (yield* (yield* Reference.Service).list()).map((reference) => reference.path)
            }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
          : []
        const whitelistedDirs = [
          Truncate.GLOB,
          path.join(Global.Path.tmp, "*"),
          ...skillDirs.map((dir) => path.join(dir, "*")),
          ...referenceDirs.map((dir) => path.join(dir, "*")),
        ]
        // Docker sandbox = real isolation: file access OUTSIDE the project is denied
        // outright (not asked) — the agent's world is the mounted project plus the
        // whitelisted app dirs (plans/skills/tmp), mirroring what the container can see.
        const externalFallback = cfg.sandbox?.runtime === "docker" ? ("deny" as const) : ("ask" as const)
        const readonlyExternalDirectory = {
          "*": externalFallback,
          ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
        } satisfies Record<string, "allow" | "ask" | "deny">

        const defaults = Permission.fromConfig({
          "*": "allow",
          doom_loop: "ask",
          external_directory: {
            "*": externalFallback,
            ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
          },
          question: "deny",
          plan_enter: "deny",
          plan_exit: "deny",
          // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
          read: {
            "*": "allow",
            "*.env": "ask",
            "*.env.*": "ask",
            "*.env.example": "allow",
          },
        })

        const user = Permission.fromConfig(cfg.permission ?? {})

        const agents: Record<string, Info> = {
          build: {
            name: "build",
            description: "The default agent. Executes tools based on configured permissions.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_enter: "allow",
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          plan: {
            name: "plan",
            description: "Plan mode. Disallows all edit tools.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_exit: "allow",
                task: {
                  general: "deny",
                },
                external_directory: {
                  [path.join(Global.Path.data, "plans", "*")]: "allow",
                },
                edit: {
                  "*": "deny",
                  [path.join(".orynrcode", "plans", "*.md")]: "allow",
                  [path.relative(ctx.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          autonomous: {
            name: "autonomous",
            description:
              "Self-directed build agent. Same full edit access as build, but keeps going until the task is done and verified — plans a todo list, works it end to end, self-verifies, and only stops when complete or genuinely blocked.",
            options: {},
            steps: 200,
            budget: { cost: 5, action: "ask" },
            confirmation: { mode: "risky" },
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_enter: "allow",
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          ralph: {
            name: "ralph",
            description:
              "Relentless, spec-driven finisher. Same full build access as build and autonomous; drives an objective all the way to done, verifying each step and restarting until complete. Hard step cap always on.",
            options: {},
            steps: 200,
            budget: { cost: 10, action: "ask" },
            confirmation: { mode: "risky" },
            max_loops: 12,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_enter: "allow",
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          "code-analyzer": {
            name: "code-analyzer",
            description:
              "Read-only code auditor. Analyzes structure, finds bugs, smells, security and performance risks — never edits. Switch to build to apply fixes.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                edit: {
                  "*": "deny",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          chat: {
            name: "chat",
            description:
              "The default switchboard. A pure router with no tools of its own — it delegates to specialist agents (research, thinking, code-analyzer, risk-analyzer, plan, character, build, autonomous, ralph) and relays their results. Tier-gated.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                edit: {
                  "*": "deny",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          "risk-analyzer": {
            name: "risk-analyzer",
            description:
              "Read-only risk & safety auditor. Rates how dangerous a proposed change or operation is — data loss, security, irreversibility, blast radius, correctness — and reports with severity. Never edits. Switch to build to act.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                edit: {
                  "*": "deny",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          character: {
            name: "character",
            description:
              "Personal-assistant persona, read-only (built on plan). A warm, attentive assistant that reads, searches, and helps you think, organize, and decide — never edits. Switch to build to make changes.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                edit: {
                  "*": "deny",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          research: {
            name: "research",
            description:
              "Read-only research agent. Investigates the web and codebase IN PARALLEL and reports findings with citations — never edits. Levels low/medium/max/ultra via options.level, or options.auto to self-escalate.",
            options: { level: "medium", auto: false },
            steps: 60,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                edit: {
                  "*": "deny",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          thinking: {
            name: "thinking",
            description:
              "Read-only reasoning agent. Reads files and reasons through problems IN PARALLEL to find answers — no web, never edits. Levels low/medium/max/ultra via options.level, or options.auto to self-escalate.",
            options: { level: "medium", auto: false },
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                websearch: "deny",
                webfetch: "deny",
                edit: {
                  "*": "deny",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          general: {
            name: "general",
            description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
          },
          explore: {
            name: "explore",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                bash: "allow",
                webfetch: "allow",
                websearch: "allow",
                read: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
            prompt: PROMPT_EXPLORE,
            options: {},
            mode: "subagent",
            native: true,
          },
          compaction: {
            name: "compaction",
            mode: "primary",
            native: true,
            hidden: true,
            prompt: PROMPT_COMPACTION,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            options: {},
          },
          title: {
            name: "title",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            temperature: 0.5,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_TITLE,
          },
          summary: {
            name: "summary",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_SUMMARY,
          },
        }

        for (const [key, value] of Object.entries(cfg.agent ?? {})) {
          if (value.disable) {
            delete agents[key]
            continue
          }
          let item = agents[key]
          if (!item)
            item = agents[key] = {
              name: key,
              mode: "all",
              permission: Permission.merge(defaults, user),
              options: {},
              native: false,
            }
          if (value.model) item.model = Provider.parseModel(value.model)
          item.variant = value.variant ?? item.variant
          item.prompt = value.prompt ?? item.prompt
          item.description = value.description ?? item.description
          item.temperature = value.temperature ?? item.temperature
          item.topP = value.top_p ?? item.topP
          item.mode = value.mode ?? item.mode
          item.color = value.color ?? item.color
          item.hidden = value.hidden ?? item.hidden
          item.name = value.name ?? item.name
          item.steps = value.steps ?? item.steps
          item.budget = value.budget ?? item.budget
          item.confirmation = value.confirmation ?? item.confirmation
          item.max_loops = value.max_loops ?? item.max_loops
          item.options = mergeDeep(item.options, value.options ?? {})
          item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
        }

        // Ensure Truncate.GLOB is allowed unless explicitly configured
        for (const name in agents) {
          const agent = agents[name]
          const explicit = agent.permission.some((r) => {
            if (r.permission !== "external_directory") return false
            if (r.action !== "deny") return false
            return r.pattern === Truncate.GLOB
          })
          if (explicit) continue

          agents[name].permission = Permission.merge(
            agents[name].permission,
            Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
          )
        }

        // ── Phase 2: switchboard + tier gating + delegation containment ────────────
        // System overlays applied LAST (above user config) so entitlement and the Chat lock
        // cannot be re-opened by user permission settings. See AUTONOMOUS-NATIVE-DESIGN.md §4.
        const TIER_ROSTER: Record<string, readonly string[]> = {
          free: ["chat"],
          starter: ["chat", "research", "thinking", "character"],
          pro: ["chat", "research", "thinking", "character", "code-analyzer", "risk-analyzer", "plan"],
          max: [
            "chat",
            "research",
            "thinking",
            "character",
            "code-analyzer",
            "risk-analyzer",
            "plan",
            "build",
            "autonomous",
            "ralph",
          ],
        }
        const tierRoster = (tier: string | undefined) => new Set(TIER_ROSTER[tier ?? "max"] ?? TIER_ROSTER.max)
        // Specialists Chat can switch-to / delegate-to; the DOING hats are delegable only from Chat.
        const SPECIALISTS = [
          "build",
          "plan",
          "autonomous",
          "ralph",
          "code-analyzer",
          "risk-analyzer",
          "character",
          "research",
          "thinking",
        ]
        const DOING_HATS = ["build", "autonomous", "ralph"]
        const denyTasks = (names: readonly string[]) =>
          Permission.fromConfig({ task: Object.fromEntries(names.map((n) => [n, "deny" as const])) })

        const rosterNow = tierRoster(cfg.tier)
        for (const name in agents) {
          const agent = agents[name]
          // 1. Specialists become switchable AND delegatable, so Chat can call them via the task tool.
          if (SPECIALISTS.includes(name)) agent.mode = "all"
          if (name === "chat") {
            // 2. Chat is a pure switchboard: deny every tool, allow only delegation. Non-overridable.
            agent.permission = Permission.merge(agent.permission, Permission.fromConfig({ "*": "deny", task: "allow" }))
            // 3. Tier gate on delegation: deny task.<agent> for every specialist not in the tier roster.
            const locked = SPECIALISTS.filter((n) => !rosterNow.has(n))
            if (locked.length) agent.permission = Permission.merge(agent.permission, denyTasks(locked))
          } else {
            // 4. Containment: only Chat may delegate to the DOING hats (prevents e.g. plan→build escape).
            agent.permission = Permission.merge(agent.permission, denyTasks(DOING_HATS))
          }
        }

        // The single tier chokepoint for PRIMARY selection: an unknown/subagent/hidden/unentitled
        // request falls back to the always-available switchboard (Chat) — no back door.
        const resolvePrimary = Effect.fnUntraced(function* (name: string | undefined) {
          const c = yield* config.get()
          const requested = name ?? c.default_agent ?? "chat"
          const agent = agents[requested]
          if (!agent || agent.mode === "subagent" || agent.hidden === true || !tierRoster(c.tier).has(requested)) {
            return agents["chat"]
          }
          return agent
        })

        const get = Effect.fnUntraced(function* (agent: string) {
          return agents[agent]
        })

        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          const roster = tierRoster(cfg.tier)
          // Tier gate on enumeration: hide primary/specialist hats the tier doesn't include, so
          // menus, the ACP directory, and describeTask only ever surface entitled agents. Internal
          // subagents (general/explore) and hidden agents stay listed (they're not user-selectable).
          const entitled = Object.values(agents).filter(
            (x) => x.mode === "subagent" || x.hidden === true || roster.has(x.name),
          )
          return pipe(
            entitled,
            sortBy(
              [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "chat"), "desc"],
              [(x) => x.name, "asc"],
            ),
          )
        })

        const defaultInfo = Effect.fnUntraced(function* () {
          // Resolve through the tier chokepoint: an unset/invalid/unentitled default_agent falls
          // back to the always-available switchboard (Chat) rather than erroring.
          return yield* resolvePrimary(undefined)
        })

        const defaultAgent = Effect.fnUntraced(function* () {
          return (yield* defaultInfo()).name
        })

        return {
          get,
          list,
          defaultInfo,
          defaultAgent,
          resolvePrimary,
        } satisfies State
      }),
    )

    return Service.of({
      get: Effect.fn("Agent.get")(function* (agent: string) {
        return yield* InstanceState.useEffect(state, (s) => s.get(agent))
      }),
      list: Effect.fn("Agent.list")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.list())
      }),
      defaultInfo: Effect.fn("Agent.defaultInfo")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultInfo())
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
      }),
      resolvePrimary: Effect.fn("Agent.resolvePrimary")(function* (name: string | undefined) {
        return yield* InstanceState.useEffect(state, (s) => s.resolvePrimary(name))
      }),
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      }) {
        const cfg = yield* config.get()
        const model = input.model ?? (yield* provider.defaultModel())
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        const language = yield* provider.getLanguage(resolved)
        const tracer = cfg.experimental?.openTelemetry
          ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
          : undefined

        const system = [PROMPT_GENERATE]
        yield* plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system })
        const existing = yield* InstanceState.useEffect(state, (s) => s.list())

        // TODO: clean this up so provider specific logic doesnt bleed over
        const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

        const params = {
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            tracer,
            metadata: {
              userId: cfg.username ?? "unknown",
            },
          },
          temperature: 0.3,
          messages: [
            ...(isOpenaiOauth
              ? []
              : system.map(
                  (item): ModelMessage => ({
                    role: "system",
                    content: item,
                  }),
                )),
            {
              role: "user",
              content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
            },
          ],
          model: language,
          schema: Object.assign(
            Schema.toStandardSchemaV1(GeneratedAgent),
            Schema.toStandardJSONSchemaV1(GeneratedAgent),
          ),
        } satisfies Parameters<typeof generateObject>[0]

        if (isOpenaiOauth) {
          return yield* Effect.promise(async () => {
            const result = streamObject({
              ...params,
              providerOptions: ProviderTransform.providerOptions(resolved, {
                instructions: system.join("\n"),
                store: false,
              }),
              onError: () => {},
            })
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return result.object
          })
        }

        return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
      }),
    })
  }),
)

const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, Auth.node, Plugin.node, Skill.node, Provider.node, locationServiceMapNode],
})

export * as Agent from "./agent"
