export * as ConfigV1 from "./config"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt, type DeepMutable } from "../../schema"
import { ConfigExperimental } from "../../config/experimental"
import { ConfigReference } from "../../config/reference"
import { ConfigAgentV1 } from "./agent"
import { ConfigAttachmentV1 } from "./attachment"
import { ConfigCommandV1 } from "./command"
import { ConfigFormatterV1 } from "./formatter"
import { ConfigLayoutV1 } from "./layout"
import { ConfigLSPV1 } from "./lsp"
import { ConfigMCPV1 } from "./mcp"
import { ConfigPermissionV1 } from "./permission"
import { ConfigPluginV1 } from "./plugin"
import { ConfigProviderV1 } from "./provider"
import { ConfigServerV1 } from "./server"
import { ConfigSkillsV1 } from "./skills"

export type Layout = ConfigLayoutV1.Layout

export const WellKnown = Schema.Struct({
  config: Schema.optional(Schema.Json),
  remote_config: Schema.optional(Schema.Json),
})

const LogLevelRef = Schema.Literals(["DEBUG", "INFO", "WARN", "ERROR"]).annotate({
  identifier: "LogLevel",
  description: "Log level",
})

export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  shell: Schema.optional(Schema.String).annotate({ description: "Default shell to use for terminal and bash tool" }),
  logLevel: Schema.optional(LogLevelRef).annotate({ description: "Log level" }),
  server: Schema.optional(ConfigServerV1.Server).annotate({
    description: "Server configuration for orynr serve and web commands",
  }),
  command: Schema.optional(Schema.Record(Schema.String, ConfigCommandV1.Info)).annotate({
    description: "Command configuration, see https://orynrcode.ai/docs/commands",
  }),
  skills: Schema.optional(ConfigSkillsV1.Info).annotate({ description: "Additional skill folder paths" }),
  references: Schema.optional(ConfigReference.Info).annotate({
    description: "Named git or local directory references",
  }),
  reference: Schema.optional(ConfigReference.Info).annotate({
    description: "@deprecated Use 'references' field instead. Named git or local directory references",
  }),
  watcher: Schema.optional(Schema.Struct({ ignore: Schema.optional(Schema.mutable(Schema.Array(Schema.String))) })),
  sandbox: Schema.optional(
    Schema.Struct({
      runtime: Schema.optional(Schema.Literals(["local", "docker"])).annotate({
        description:
          "Where the agent runs shell commands: 'local' (host process, default) or 'docker' (per-session container).",
      }),
      image: Schema.optional(Schema.String).annotate({
        description: "Docker image for the sandbox container. Only used when runtime is 'docker'.",
      }),
    }),
  ).annotate({ description: "Execution sandbox configuration (local host, or a per-session docker container)." }),
  snapshot: Schema.optional(Schema.Boolean).annotate({
    description:
      "Enable or disable snapshot tracking. When false, filesystem snapshots are not recorded and undoing or reverting will not undo/redo file changes. Defaults to true.",
  }),
  plugin: Schema.optional(Schema.mutable(Schema.Array(ConfigPluginV1.Spec))),
  share: Schema.optional(Schema.Literals(["manual", "auto", "disabled"])).annotate({
    description:
      "Control sharing behavior:'manual' allows manual sharing via commands, 'auto' enables automatic sharing, 'disabled' disables all sharing",
  }),
  autoshare: Schema.optional(Schema.Boolean).annotate({
    description: "@deprecated Use 'share' field instead. Share newly created sessions automatically",
  }),
  autoupdate: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal("notify")])).annotate({
    description:
      "Automatically update to the latest version. Set to true to auto-update, false to disable, or 'notify' to show update notifications",
  }),
  disabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Disable providers that are loaded automatically",
  }),
  enabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "When set, ONLY these providers will be enabled. All other providers will be ignored",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Model to use in the format of provider/model, eg anthropic/claude-2",
  }),
  small_model: Schema.optional(Schema.String).annotate({
    description: "Small model to use for tasks like title generation in the format of provider/model",
  }),
  default_agent: Schema.optional(Schema.String).annotate({
    description:
      "Default agent to use when none is specified. Must be a primary agent. Falls back to 'build' if not set or if the specified agent is invalid.",
  }),
  tier: Schema.optional(Schema.Literals(["free", "starter", "pro", "max"])).annotate({
    description:
      "Subscription tier. Gates which specialist agents Chat can delegate to and which primary agents are reachable at all (free = Chat only; higher tiers unlock more). Terminal build: a config value (defaults to 'max'); the web backend supplies it from billing.",
  }),
  username: Schema.optional(Schema.String).annotate({
    description: "Custom username to display in conversations instead of system username",
  }),
  mode: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({ build: Schema.optional(ConfigAgentV1.Info), plan: Schema.optional(ConfigAgentV1.Info) }),
      [Schema.Record(Schema.String, ConfigAgentV1.Info)],
    ),
  ).annotate({ description: "@deprecated Use `agent` field instead." }),
  agent: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        plan: Schema.optional(ConfigAgentV1.Info),
        build: Schema.optional(ConfigAgentV1.Info),
        general: Schema.optional(ConfigAgentV1.Info),
        explore: Schema.optional(ConfigAgentV1.Info),
        title: Schema.optional(ConfigAgentV1.Info),
        summary: Schema.optional(ConfigAgentV1.Info),
        compaction: Schema.optional(ConfigAgentV1.Info),
      }),
      [Schema.Record(Schema.String, ConfigAgentV1.Info)],
    ),
  ).annotate({ description: "Agent configuration, see https://orynrcode.ai/docs/agents" }),
  provider: Schema.optional(Schema.Record(Schema.String, ConfigProviderV1.Info)).annotate({
    description: "Custom provider configurations and model overrides",
  }),
  mcp: Schema.optional(
    Schema.Record(Schema.String, Schema.Union([ConfigMCPV1.Info, Schema.Struct({ enabled: Schema.Boolean })])),
  ).annotate({ description: "MCP (Model Context Protocol) server configurations" }),
  formatter: Schema.optional(ConfigFormatterV1.Info).annotate({
    description:
      "Enable or configure formatters. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.",
  }),
  lsp: Schema.optional(ConfigLSPV1.Info).annotate({
    description:
      "Enable or configure LSP servers. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.",
  }),
  instructions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Additional instruction files or patterns to include",
  }),
  layout: Schema.optional(ConfigLayoutV1.Layout).annotate({ description: "@deprecated Always uses stretch layout." }),
  permission: Schema.optional(ConfigPermissionV1.Info),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  attachment: Schema.optional(ConfigAttachmentV1.Info).annotate({
    description: "Attachment processing configuration, including image size limits and resizing behavior",
  }),
  enterprise: Schema.optional(
    Schema.Struct({ url: Schema.optional(Schema.String).annotate({ description: "Enterprise URL" }) }),
  ),
  tool_output: Schema.optional(
    Schema.Struct({
      max_lines: Schema.optional(PositiveInt).annotate({
        description: "Maximum lines of tool output before it is truncated and saved to disk (default: 2000)",
      }),
      max_bytes: Schema.optional(PositiveInt).annotate({
        description: "Maximum bytes of tool output before it is truncated and saved to disk (default: 51200)",
      }),
    }),
  ).annotate({
    description:
      "Thresholds for truncating tool output. When output exceeds either limit, the full text is written to the truncation directory and a preview is returned.",
  }),
  compaction: Schema.optional(
    Schema.Struct({
      auto: Schema.optional(Schema.Boolean).annotate({
        description: "Enable automatic compaction when context is full (default: true)",
      }),
      mode: Schema.optional(Schema.Literals(["auto", "off"])).annotate({
        description:
          "Compaction mode: 'auto' (summarize when the context fills, default) or 'off' (true NoOp — keep full history, error only on real overflow).",
      }),
      max_size: Schema.optional(Schema.NullOr(PositiveInt)).annotate({
        description:
          "Proactively compact once the conversation exceeds this many messages. null or omitted = only compact on context overflow.",
      }),
      keep_first: Schema.optional(NonNegativeInt).annotate({
        description: "Number of leading turns kept verbatim and never summarized. Default 0.",
      }),
      prune: Schema.optional(Schema.Boolean).annotate({
        description: "Enable pruning of old tool outputs (default: false)",
      }),
      tail_turns: Schema.optional(NonNegativeInt).annotate({
        description:
          "Number of recent user turns, including their following assistant/tool responses, to keep verbatim during compaction (default: 2)",
      }),
      preserve_recent_tokens: Schema.optional(NonNegativeInt).annotate({
        description: "Maximum number of tokens from recent turns to preserve verbatim after compaction",
      }),
      reserved: Schema.optional(NonNegativeInt).annotate({
        description: "Token buffer for compaction. Leaves enough window to avoid overflow during compaction.",
      }),
    }),
  ),
  confirmation: Schema.optional(
    Schema.Struct({
      mode: Schema.optional(Schema.Literals(["never", "risky", "always"])).annotate({
        description:
          "When a doing-agent pauses for your approval: 'never' (full auto), 'risky' (only actions the risk check flags), 'always' (every mutating action). Chat never triggers this. Default 'never' (build keeps today's behavior).",
      }),
      analyzer: Schema.optional(Schema.Literals(["auto", "heuristic", "llm", "none"])).annotate({
        description:
          "Risk classifier feeding 'risky' mode: 'auto' (llm if small_model set, else heuristic), 'heuristic', 'llm', or 'none'. Default 'auto'. 'none' + 'risky' fails safe to always-ask.",
      }),
      risk_threshold: Schema.optional(Schema.Literals(["safe", "low", "medium", "high", "critical"])).annotate({
        description:
          "Severity at or above which 'risky' mode pauses. Default 'medium'. Unknown risk always escalates to ask (fail-closed).",
      }),
      model: Schema.optional(Schema.NullOr(Schema.String)).annotate({
        description: "provider/model for the llm risk analyzer. null or omitted = use small_model.",
      }),
    }),
  ).annotate({
    description: "Human-in-the-loop confirmation policy for agents that change things (the 3-way ask-me gate).",
  }),
  stuck: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean).annotate({ description: "Enable the stuck/loop detector. Default true." }),
      action_observation: Schema.optional(PositiveInt).annotate({
        description: "Trip after this many identical action→observation repeats. Default 4.",
      }),
      action_error: Schema.optional(PositiveInt).annotate({
        description: "Trip after this many repeated identical errors. Default 3.",
      }),
      monologue: Schema.optional(PositiveInt).annotate({
        description: "Trip after this many assistant turns with no tool call. Default 3.",
      }),
      alternating: Schema.optional(PositiveInt).annotate({
        description: "Trip after this many alternating action/observation cycles. Default 6.",
      }),
      scan_window: Schema.optional(PositiveInt).annotate({
        description: "How many recent events the detector scans. Default 20.",
      }),
    }),
  ).annotate({ description: "Stuck / loop detector for self-driving agents." }),
  setup: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean).annotate({
        description: "Run the project setup script on start. Default true.",
      }),
      script: Schema.optional(Schema.String).annotate({
        description: "Path to the setup script. Default '.orynrcode/setup.sh'.",
      }),
      timeout: Schema.optional(PositiveInt).annotate({ description: "Setup script timeout in seconds. Default 600." }),
      hooks: Schema.optional(Schema.Boolean).annotate({
        description: "Install the git pre-commit hook, preserving any existing one. Default true.",
      }),
    }),
  ).annotate({ description: "Project setup-script runner and git-hook installer." }),
  headless: Schema.optional(
    Schema.Struct({
      on_ask: Schema.optional(Schema.Literals(["deny", "timeout"])).annotate({
        description:
          "What to do when a confirmation would be needed in a non-interactive run (no human to ask): 'deny' (clean stop, default) or 'timeout'. Applies to the budget/doom_loop/setup gates.",
      }),
      timeout: Schema.optional(NonNegativeInt).annotate({
        description: "Seconds to wait for on_ask:'timeout' before denying. 0 = immediate deny.",
      }),
    }),
  ).annotate({ description: "Non-interactive (headless) permission policy for runs with no human to confirm." }),
  experimental: Schema.optional(
    Schema.Struct({
      disable_paste_summary: Schema.optional(Schema.Boolean),
      batch_tool: Schema.optional(Schema.Boolean).annotate({ description: "Enable the batch tool" }),
      openTelemetry: Schema.optional(Schema.Boolean).annotate({
        description: "Enable OpenTelemetry spans for AI SDK calls (using the 'experimental_telemetry' flag)",
      }),
      primary_tools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
        description: "Tools that should only be available to primary agents.",
      }),
      continue_loop_on_deny: Schema.optional(Schema.Boolean).annotate({
        description: "Continue the agent loop when a tool call is denied",
      }),
      status_analytics: Schema.optional(Schema.Boolean).annotate({
        description:
          "Emit execution-status analytics events (running/waiting/idle/error/stuck transitions). Default false.",
      }),
      background_subagents: Schema.optional(Schema.Boolean).annotate({
        description: "Allow delegated sub-agents to run in the background. Default false.",
      }),
      max_subagents: Schema.optional(PositiveInt).annotate({
        description:
          "Hard cap on sub-agents spawned per run (task-tree safety backstop, belt-and-suspenders with budget). Default 8.",
      }),
      cooperative_pause: Schema.optional(Schema.Boolean).annotate({
        description: "Enable loop-level cooperative pause/resume (break-and-mark-resumable). Default true.",
      }),
      visible_tools_hiding: Schema.optional(Schema.Boolean).annotate({
        description:
          "Hide '*:deny' tools from the model instead of surfacing-then-refusing (affects plan-toolset fidelity). Default false.",
      }),
      mcp_timeout: Schema.optional(PositiveInt).annotate({
        description: "Timeout in milliseconds for model context protocol (MCP) requests",
      }),
      policies: Schema.optional(Schema.mutable(Schema.Array(ConfigExperimental.Policy))).annotate({
        description: "Policy statements applied to supported resources, such as provider access",
      }),
    }),
  ),
}).annotate({ identifier: "Config" })

export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>
