import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { fileURLToPath, pathToFileURL } from "url"
import { Effect, Layer, Result, Schema } from "effect"
import { LayerNode } from "@orynr-ai/core/effect/layer-node"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"

import { ToolJsonSchema } from "@/tool/json-schema"
import { MessageID, SessionID } from "@/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@orynr-ai/core/provider"
import { ModelV2 } from "@orynr-ai/core/model"
import { MCP } from "@/mcp"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".orynrcode")])),
})

// Fake Plugin.Service that returns a single plugin whose `tool` map contains
// one definition with `args: undefined`. Used to exercise the plugin entry
// point of `fromPlugin` for the #27451 / #27630 regression.
const brokenPluginLayer = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    init: () => Effect.void,
    trigger: ((_name: unknown, _input: unknown, output: unknown) =>
      Effect.succeed(output)) as Plugin.Interface["trigger"],
    list: () =>
      Effect.succeed([
        {
          tool: {
            broken_plugin_tool: {
              description: "plugin tool with missing args",
              args: undefined as unknown as Record<string, never>,
              execute: async () => "ok",
            },
          },
        },
      ]),
  }),
)

const root = LayerNode.group([ToolRegistry.node, Agent.node])
const replacements = [
  [Config.node, configLayer],
  [RuntimeFlags.node, RuntimeFlags.layer()],
] as const

const it = testEffect(LayerNode.compile(root, replacements))
const withCodeMode = testEffect(
  LayerNode.compile(root, [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalCodeMode: true })],
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        tools: () =>
          Effect.succeed({
            weather_current: {
              def: {
                name: "current",
                description: "current weather",
                inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
              } as MCPToolDef,
              client: {} as MCP.McpTool["client"],
            },
          }),
        clients: () => Effect.succeed({ weather: {} as any }),
      }),
    ],
  ]),
)
const withEmptyCodeMode = testEffect(
  LayerNode.compile(root, [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalCodeMode: true })],
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        tools: () => Effect.succeed({}),
        clients: () => Effect.succeed({}),
      }),
    ],
  ]),
)
const withBrokenPlugin = testEffect(LayerNode.compile(root, [...replacements, [Plugin.node, brokenPluginLayer]]))

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.registry", () => {
  it.instance("does not expose task_status", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      expect(ids).not.toContain("task_status")
    }),
  )

  it.instance("does not expose execute unless code mode is enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      expect(ids).not.toContain("execute")
    }),
  )

  withCodeMode.instance("exposes execute when code mode is enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const ids = yield* registry.ids()
      // The default agent is now the chat switchboard, which denies every tool
      // ("*": deny, task: allow) — so use a working agent (build) to see execute.
      const build = yield* agents.get("build")
      if (!build) throw new Error("build agent not found")
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.anthropic,
        modelID: ModelV2.ID.make("test"),
        agent: build,
      })
      const execute = tools.find((tool) => tool.id === "execute")

      expect(ids).toContain("execute")
      expect(tools.map((tool) => tool.id)).toContain("execute")
      expect(execute?.description).toContain("tools.weather.current(input: {\n  city: string,\n})")
    }),
  )

  withCodeMode.instance("hides execute from the chat switchboard even in code mode", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      // Chat's non-overridable "*": deny leaves no visible MCP tools, so the
      // execute tool is withheld for it despite code mode + a populated catalog.
      const chat = yield* agents.defaultInfo()
      expect(chat.name).toBe("chat")
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.anthropic,
        modelID: ModelV2.ID.make("test"),
        agent: chat,
      })

      expect(tools.map((tool) => tool.id)).not.toContain("execute")
    }),
  )

  withEmptyCodeMode.instance("does not expose execute when code mode has no visible tools", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      // Use build (which can see MCP tools) so this exercises the empty-catalog
      // path rather than trivially passing through chat's deny-all lockdown.
      const build = yield* agents.get("build")
      if (!build) throw new Error("build agent not found")
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.anthropic,
        modelID: ModelV2.ID.make("test"),
        agent: build,
      })

      expect(tools.map((tool) => tool.id)).not.toContain("execute")
    }),
  )

  it.instance("hides task background parameter unless experimental background subagents are enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agent = yield* Agent.Service
      const build = yield* agent.get("build")
      if (!build) throw new Error("build agent not found")
      const task = (yield* registry.tools({
        providerID: ProviderV2.ID.anthropic,
        modelID: ModelV2.ID.make("test"),
        agent: build,
      })).find((tool) => tool.id === "task")

      expect(task?.jsonSchema).toBeDefined()
      expect((task?.jsonSchema?.properties as Record<string, unknown> | undefined)?.background).toBeUndefined()
    }),
  )

  it.instance("loads tools from .orynrcode/tool (singular)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const configDir = path.join(test.directory, ".orynrcode")
      const tool = path.join(configDir, "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("hello")
    }),
  )

  it.instance("ignores non-tool exports in .orynrcode/tool files", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tool = path.join(test.directory, ".orynrcode", "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "mixed.ts"),
          [
            "export const helper = 'not a tool'",
            "export default {",
            "  description: 'mixed tool',",
            "  args: {},",
            "  execute: async () => 'ok',",
            "}",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("mixed")
      expect(ids).not.toContain("mixed_helper")
    }),
  )

  // Regression for #27451 / #27630: a custom tool that omits `args` must not
  // crash registry initialization with
  // `Object.entries requires that input parameter not be null or undefined`.
  // Pre-1.14.49 the code path was `z.object(def.args)`, and `z.object(undefined)`
  // silently produced an empty schema — so the tool registered as no-args.
  // Preserve that tolerance.
  it.instance("tolerates a custom tool exporting null/undefined args (no-args fallback)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tool = path.join(test.directory, ".orynrcode", "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "noargs.ts"),
          [
            "export default {",
            "  description: 'tool with no args',",
            "  args: undefined,",
            "  execute: async () => 'ok',",
            "}",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      // Built-in tools must still load — a single malformed custom tool must
      // not poison the whole registry.
      expect(ids).toContain("read")
      const loaded = (yield* registry.all()).find((t) => t.id === "noargs")
      if (!loaded) throw new Error("noargs tool was not loaded")
      expect(loaded.jsonSchema).toMatchObject({ type: "object", properties: {} })
    }),
  )

  // Same regression, plugin entry point. The original reports (#27451, #27630)
  // came in through `plugin.list()` — `oh-my-orynrcode` was registering a tool
  // with `args: undefined` and crashing every message submit. The file-scan
  // and plugin-list loops both funnel through `fromPlugin`, but covering both
  // entry points means a future refactor that splits them won't silently lose
  // protection.
  withBrokenPlugin.instance("tolerates a plugin tool registered with null/undefined args", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("read")
      expect(ids).toContain("broken_plugin_tool")
    }),
  )

  it.instance("loads tools from .orynrcode/tools (plural)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const configDir = path.join(test.directory, ".orynrcode")
      const tools = path.join(configDir, "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("hello")
    }),
  )

  it.instance("loads Zod-schema custom tools with JSON Schema and validation", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const customTools = path.join(test.directory, ".orynrcode", "tools")
      const pluginTool = pathToFileURL(path.resolve(import.meta.dir, "../../../plugin/src/tool.ts")).href
      yield* Effect.promise(() => fs.mkdir(customTools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(customTools, "sql.ts"),
          [
            `import { tool } from ${JSON.stringify(pluginTool)}`,
            "export default tool({",
            "  description: 'query database',",
            "  args: { query: tool.schema.string().describe('SQL query to execute') },",
            "  execute: async ({ query }) => query,",
            "})",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const loaded = (yield* registry.all()).find((tool) => tool.id === "sql")
      if (!loaded) throw new Error("custom sql tool was not loaded")
      expect(loaded?.jsonSchema).toMatchObject({
        type: "object",
        properties: {
          query: { type: "string", description: "SQL query to execute" },
        },
        required: ["query"],
      })
      expect(Result.isSuccess(Schema.decodeUnknownResult(loaded.parameters)({ query: "select 1" }))).toBe(true)
      expect(Result.isSuccess(Schema.decodeUnknownResult(loaded.parameters)({}))).toBe(false)

      const agents = yield* Agent.Service
      const promptTools = yield* registry.tools({
        providerID: ProviderV2.ID.anthropic,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })
      const promptTool = promptTools.find((tool) => tool.id === "sql")
      if (!promptTool) throw new Error("custom sql tool was not returned for prompts")
      expect(ToolJsonSchema.fromTool(promptTool)).toMatchObject({
        properties: {
          query: { type: "string", description: "SQL query to execute" },
        },
        required: ["query"],
      })
    }),
  )

  it.instance(
    "preserves Zod arg descriptions from older config-scoped plugin packages",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const configDir = path.join(test.directory, ".orynrcode")
        const customTools = path.join(configDir, "tools")
        const plugin = path.join(configDir, "node_modules", "@orynr-ai", "plugin")
        yield* Effect.promise(() => fs.mkdir(path.join(plugin, "dist"), { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(customTools, { recursive: true }))
        yield* Effect.promise(() =>
          fs.cp(path.dirname(fileURLToPath(import.meta.resolve("zod"))), path.join(configDir, "node_modules", "zod"), {
            dereference: true,
            recursive: true,
          }),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(plugin, "package.json"),
            JSON.stringify({ name: "@orynr-ai/plugin", type: "module", exports: { ".": "./dist/index.js" } }),
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(plugin, "dist", "index.js"),
            [
              "import { z } from 'zod'",
              "export function tool(input) {",
              "  return input",
              "}",
              "tool.schema = z",
              "",
            ].join("\n"),
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(customTools, "addition.ts"),
            [
              'import { tool } from "@orynr-ai/plugin"',
              "export default tool({",
              "  description: 'Use this tool to add two numbers and return their sum.',",
              "  args: {",
              "    left: tool.schema.number().describe('The first number to add'),",
              "    right: tool.schema.number().describe('The second number to add'),",
              "  },",
              "  execute: async (args) => `${args.left} + ${args.right} = ${args.left + args.right}`,",
              "})",
              "",
            ].join("\n"),
          ),
        )

        const registry = yield* ToolRegistry.Service
        const loaded = (yield* registry.all()).find((tool) => tool.id === "addition")
        if (!loaded) throw new Error("custom addition tool was not loaded")

        expect(ToolJsonSchema.fromTool(loaded)).toMatchObject({
          properties: {
            left: { type: "number", description: "The first number to add" },
            right: { type: "number", description: "The second number to add" },
          },
        })
      }),
    20_000,
  )

  it.instance("preserves attachments from structured custom tool results", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const customTools = path.join(test.directory, ".orynrcode", "tools")
      const pluginTool = pathToFileURL(path.resolve(import.meta.dir, "../../../plugin/src/tool.ts")).href
      yield* Effect.promise(() => fs.mkdir(customTools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(customTools, "image.ts"),
          [
            `import { tool } from ${JSON.stringify(pluginTool)}`,
            "export default tool({",
            "  description: 'image tool',",
            "  args: {},",
            "  execute: async () => ({",
            "    output: 'here is an image',",
            "    attachments: [{ type: 'file', mime: 'image/png', filename: 'picture.png', url: 'data:image/png;base64,AAAA' }],",
            "  }),",
            "})",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const loaded = (yield* registry.all()).find((tool) => tool.id === "image")
      if (!loaded) throw new Error("custom image tool was not loaded")
      const agents = yield* Agent.Service
      const result = yield* loaded.execute({}, {
        sessionID: SessionID.make("ses_test"),
        messageID: MessageID.make("msg_test"),
        agent: (yield* agents.defaultInfo()).name,
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      } satisfies Tool.Context)

      expect(result.output).toBe("here is an image")
      expect(result.attachments).toEqual([
        { type: "file", mime: "image/png", filename: "picture.png", url: "data:image/png;base64,AAAA" },
      ])
    }),
  )

  it.instance("loads legacy JSON-schema-shaped custom tools with wire schema", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tools = path.join(test.directory, ".orynrcode", "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "legacy.ts"),
          [
            "export default {",
            "  description: 'legacy schema tool',",
            "  args: { text: { type: 'string', description: 'Text to render' } },",
            "  execute: async ({ text }) => text,",
            "}",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const loaded = (yield* registry.all()).find((tool) => tool.id === "legacy")
      if (!loaded) throw new Error("legacy custom tool was not loaded")
      expect(ToolJsonSchema.fromTool(loaded)).toMatchObject({
        type: "object",
        properties: {
          text: { type: "string", description: "Text to render" },
        },
        required: ["text"],
      })
    }),
  )

  it.instance("loads tools with external dependencies without crashing", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const configDir = path.join(test.directory, ".orynrcode")
      const tools = path.join(configDir, "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(configDir, "package.json"),
          JSON.stringify({
            name: "custom-tools",
            dependencies: {
              "@orynr-ai/plugin": "^0.0.0",
              cowsay: "^1.6.0",
            },
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(configDir, "package-lock.json"),
          JSON.stringify({
            name: "custom-tools",
            lockfileVersion: 3,
            packages: {
              "": {
                dependencies: {
                  "@orynr-ai/plugin": "^0.0.0",
                  cowsay: "^1.6.0",
                },
              },
            },
          }),
        ),
      )

      const cowsay = path.join(configDir, "node_modules", "cowsay")
      yield* Effect.promise(() => fs.mkdir(cowsay, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(cowsay, "package.json"),
          JSON.stringify({
            name: "cowsay",
            type: "module",
            exports: "./index.js",
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(cowsay, "index.js"),
          ["export function say({ text }) {", "  return `moo ${text}`", "}", ""].join("\n"),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "cowsay.ts"),
          [
            "import { say } from 'cowsay'",
            "export default {",
            "  description: 'tool that imports cowsay at top level',",
            "  args: { text: { type: 'string' } },",
            "  execute: async ({ text }: { text: string }) => {",
            "    return say({ text })",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("cowsay")
    }),
  )
})
