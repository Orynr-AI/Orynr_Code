import { LayerNode } from "@orynr-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"

import { InstanceState } from "@/effect/instance-state"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Config } from "@/config/config"
import { Skill } from "@/skill"
import { AbsolutePath } from "@orynr-ai/core/schema"
import { Location } from "@orynr-ai/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@orynr-ai/core/location-services"
import { Reference } from "@orynr-ai/core/reference"
import { MCP } from "@/mcp"
import { PermissionV1 } from "@orynr-ai/core/v1/permission"

export function provider(model: Provider.Model) {
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  if (model.api.id.includes("gpt")) {
    if (model.api.id.includes("codex")) {
      return [PROMPT_CODEX]
    }
    return [PROMPT_GPT]
  }
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  if (model.api.id.toLowerCase().includes("kimi")) return [PROMPT_KIMI]
  return [PROMPT_DEFAULT]
}

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
  readonly mcp: (agent: Agent.Info, permission?: PermissionV1.Ruleset) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@orynr/SystemPrompt") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const mcp = yield* MCP.Service
    const config = yield* Config.Service
    const locations = yield* LocationServiceMap.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model) {
        const ctx = yield* InstanceState.context
        const cfg = yield* config.get()
        const docker = cfg.sandbox?.runtime === "docker"
        const references = yield* Effect.gen(function* () {
          return (yield* (yield* Reference.Service).list()).filter((reference) => reference.description !== undefined)
        }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
        return [
          [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            // In docker mode shell commands execute inside a Linux container with the
            // project bind-mounted at /workspace; describe THAT world so the model
            // doesn't reason from host facts it cannot touch.
            ...(docker
              ? [
                  // Deliberately NO host paths here: the container is the model's whole
                  // world — it shouldn't even be handed the host's directory layout.
                  `  Execution sandbox: docker container (image ${cfg.sandbox?.image ?? "ubuntu:24.04"})`,
                  `  Working directory: /workspace (the project)`,
                  `  Platform (shell commands): linux — they run INSIDE the container`,
                  `  File tools (read/edit/write) operate on the project only; paths outside it are denied.`,
                ]
              : [
                  `  Working directory: ${ctx.directory}`,
                  `  Workspace root folder: ${ctx.worktree}`,
                  `  Platform: ${process.platform}`,
                ]),
            `  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
            `  Today's date: ${new Date().toDateString()}`,
            `</env>`,
          ].join("\n"),
          // Self-awareness rules, mirroring the plan-mode reflex ("I'm in plan mode, I
          // can't edit"): the agent must KNOW its containment and say so, rather than
          // attempting host actions or probing to find out.
          docker
            ? [
                `Sandbox self-awareness: you are running inside an isolated Linux docker container.`,
                `- Treat the <env> block as authoritative — you do not need to run commands to discover your environment.`,
                `- You can ONLY work inside the mounted project (/workspace). You CANNOT touch anything else on the user's computer: no host files outside the project, no host applications, no OS settings. Such paths are denied.`,
                `- This is Linux. EVERY path you mention is a container path under /workspace (e.g. /workspace/test.txt). NEVER write Windows paths, drive letters (C:\\...), backslash paths, or PowerShell/cmd commands — they do not exist here. The shell is bash.`,
                `- You cannot see the user's host machine or its folder layout, so NEVER tell the user to run a command with a host path as a workaround — any such path would be a guess and likely wrong. If you cannot do something yourself, offer to switch to the build agent (which acts inside this same container), not a manual host command.`,
                `- If asked where or what you are running on, answer directly: a Linux docker container with the project mounted at /workspace.`,
              ].join("\n")
            : [
                `Sandbox self-awareness: the execution sandbox is LOCAL — your shell commands run directly on the user's machine (platform ${process.platform}).`,
                `- A docker runtime is also available; if the user wants isolation, point them to /sandbox (choose docker).`,
              ].join("\n"),
          references.length === 0
            ? undefined
            : [
                "Project references provide additional directories that can be accessed when relevant.",
                "<available_references>",
                ...references
                  .toSorted((a, b) => a.name.localeCompare(b.name))
                  .flatMap((reference) => [
                    "  <reference>",
                    `    <name>${reference.name}</name>`,
                    `    <path>${reference.path}</path>`,
                    ...(reference.description === undefined
                      ? []
                      : [`    <description>${reference.description}</description>`]),
                    "  </reference>",
                  ]),
                "</available_references>",
              ].join("\n"),
        ].filter((part): part is string => part !== undefined)
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),

      mcp: Effect.fn("SystemPrompt.mcp")(function* (agent: Agent.Info, permission?: PermissionV1.Ruleset) {
        const ruleset = Permission.merge(agent.permission, permission ?? [])
        const instructions = (yield* mcp.instructions()).filter(
          (item) => item.tools.length === 0 || Permission.disabled(item.tools, ruleset).size < item.tools.length,
        )
        if (instructions.length === 0) return

        return [
          "<mcp_instructions>",
          ...instructions.flatMap((item) => [
            `  <server name="${item.name}">`,
            ...item.instructions.split("\n").map((line) => `    ${line}`),
            "  </server>",
          ]),
          "</mcp_instructions>",
        ].join("\n")
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
  deps: [Skill.node, MCP.node, Config.node, locationServiceMapNode],
})

export * as SystemPrompt from "./system"
