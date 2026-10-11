import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@orynr-ai/core/v1/session"
import path from "path"
import { Effect, FileSystem, Layer } from "effect"
import { CrossSpawnSpawner } from "@orynr-ai/core/cross-spawn-spawner"

import { Instruction } from "../../src/session/instruction"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Global } from "@orynr-ai/core/global"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { provideInstance, provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { ProviderV2 } from "@orynr-ai/core/provider"
import { ModelV2 } from "@orynr-ai/core/model"
import { AppNodeBuilder } from "@orynr-ai/core/effect/app-node-builder"
import { LayerNode } from "@orynr-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@orynr-ai/core/effect/app-node-platform"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Config } from "@/config/config"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]), [
    [
      InstanceBootstrap.node,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ]),
)

const configLayer = Layer.succeed(Config.Service, TestConfig.make())

const instructionLayer = (global: Partial<Global.Interface>, flags: Partial<RuntimeFlags.Info> = {}) =>
  AppNodeBuilder.build(Instruction.node, [
    [Config.node, configLayer],
    [Global.node, Global.layerWith(global)],
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
  ])

const provideInstruction =
  (global: Partial<Global.Interface>, flags?: Partial<RuntimeFlags.Info>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Effect.provide(instructionLayer(global, flags)))

// Same as provideInstruction but with the sandbox runtime forced to docker, so the
// instruction loader takes its docker path-mapping branch.
const dockerConfigLayer = Layer.succeed(
  Config.Service,
  TestConfig.make({ get: () => Effect.succeed({ sandbox: { runtime: "docker" } }) }),
)
const provideInstructionDocker =
  (global: Partial<Global.Interface>, flags: Partial<RuntimeFlags.Info> = {}) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(
      Effect.provide(
        AppNodeBuilder.build(Instruction.node, [
          [Config.node, dockerConfigLayer],
          [Global.node, Global.layerWith(global)],
          [RuntimeFlags.node, RuntimeFlags.layer(flags)],
        ]),
      ),
    )

const write = (filepath: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.dirname(filepath), { recursive: true })
    yield* fs.writeFileString(filepath, content)
  })

const writeFiles = (dir: string, files: Record<string, string>) =>
  Effect.all(
    Object.entries(files).map(([file, content]) => write(path.join(dir, file), content)),
    { discard: true },
  )

const withFiles = <A, E, R>(files: Record<string, string>, self: (dir: string) => Effect.Effect<A, E, R>) =>
  provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      yield* writeFiles(dir, files)
      return yield* self(dir).pipe(provideInstruction({ home: dir, config: dir }))
    }),
  )

const tmpWithFiles = (files: Record<string, string>, options?: { git?: boolean }) =>
  Effect.gen(function* () {
    // git: true bounds the project worktree to the tmp dir itself; without it the
    // instance resolves as the "global" project (worktree "/") and instruction
    // discovery walks OS-tmpdir ancestors, leaking any real ORYNR.md on the host.
    const dir = yield* tmpdirScoped(options)
    yield* writeFiles(dir, files)
    return dir
  })

function loaded(filepath: string): SessionV1.WithParts[] {
  const sessionID = SessionID.make("session-loaded-1")
  const messageID = MessageID.make("msg_message-loaded-1")

  return [
    {
      info: {
        id: messageID,
        sessionID,
        role: "user",
        time: { created: 0 },
        agent: "build",
        model: {
          providerID: ProviderV2.ID.make("anthropic"),
          modelID: ModelV2.ID.make("claude-sonnet-4-20250514"),
        },
      },
      parts: [
        {
          id: PartID.make("prt_part-loaded-1"),
          messageID,
          sessionID,
          type: "tool",
          callID: "call-loaded-1",
          tool: "read",
          state: {
            status: "completed",
            input: {},
            output: "done",
            title: "Read",
            metadata: { loaded: [filepath] },
            time: { start: 0, end: 1 },
          },
        },
      ],
    },
  ]
}

describe("Instruction.resolve", () => {
  it.live("returns empty when ORYNR.md is at project root (already in systemPaths)", () =>
    withFiles({ "ORYNR.md": "# Root Instructions", "src/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const system = yield* svc.systemPaths()
        expect(system.has(path.join(dir, "ORYNR.md"))).toBe(true)

        const results = yield* svc.resolve([], path.join(dir, "src", "file.ts"), MessageID.make("msg_message-test-1"))
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("returns ORYNR.md from subdirectory (not in systemPaths)", () =>
    withFiles({ "subdir/ORYNR.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const system = yield* svc.systemPaths()
        expect(system.has(path.join(dir, "subdir", "ORYNR.md"))).toBe(false)

        const results = yield* svc.resolve(
          [],
          path.join(dir, "subdir", "nested", "file.ts"),
          MessageID.make("msg_message-test-2"),
        )
        expect(results.length).toBe(1)
        expect(results[0].filepath).toBe(path.join(dir, "subdir", "ORYNR.md"))
      }),
    ),
  )

  it.live("doesn't reload ORYNR.md when reading it directly", () =>
    withFiles({ "subdir/ORYNR.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "ORYNR.md")
        const system = yield* svc.systemPaths()
        expect(system.has(filepath)).toBe(false)

        const results = yield* svc.resolve([], filepath, MessageID.make("msg_message-test-3"))
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("does not reattach the same nearby instructions twice for one message", () =>
    withFiles({ "subdir/ORYNR.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-1")

        const first = yield* svc.resolve([], filepath, id)
        const second = yield* svc.resolve([], filepath, id)

        expect(first).toHaveLength(1)
        expect(first[0].filepath).toBe(path.join(dir, "subdir", "ORYNR.md"))
        expect(second).toEqual([])
      }),
    ),
  )

  it.live("clear allows nearby instructions to be attached again for the same message", () =>
    withFiles({ "subdir/ORYNR.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-2")

        const first = yield* svc.resolve([], filepath, id)
        yield* svc.clear(id)
        const second = yield* svc.resolve([], filepath, id)

        expect(first).toHaveLength(1)
        expect(second).toHaveLength(1)
        expect(second[0].filepath).toBe(path.join(dir, "subdir", "ORYNR.md"))
      }),
    ),
  )

  it.live("skips instructions already reported by prior read metadata", () =>
    withFiles({ "subdir/ORYNR.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const agents = path.join(dir, "subdir", "ORYNR.md")
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-3")

        const results = yield* svc.resolve(loaded(agents), filepath, id)
        expect(results).toEqual([])
      }),
    ),
  )

  test.todo("fetches remote instructions from config URLs via HttpClient", () => {})
})

describe("Instruction.system", () => {
  it.live("loads both project and global ORYNR.md when both exist", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "ORYNR.md": "# Global Instructions" })
      const projectTmp = yield* tmpWithFiles({ "ORYNR.md": "# Project Instructions" }, { git: true })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(projectTmp, "ORYNR.md"))).toBe(true)
        expect(paths.has(path.join(globalTmp, "ORYNR.md"))).toBe(true)

        const rules = yield* svc.system()
        expect(rules).toHaveLength(2)
        expect(rules[0]).toBe(`Instructions from: ${path.join(globalTmp, "ORYNR.md")}\n# Global Instructions`)
        expect(rules[1]).toBe(`Instructions from: ${path.join(projectTmp, "ORYNR.md")}\n# Project Instructions`)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )

  it.live("skips project and global CLAUDE.md when Claude Code prompt is disabled", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ ".claude/CLAUDE.md": "# Global Claude" })
      const projectTmp = yield* tmpWithFiles({ "CLAUDE.md": "# Project Claude" }, { git: true })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, ".claude", "CLAUDE.md"))).toBe(false)
        expect(paths.has(path.join(projectTmp, "CLAUDE.md"))).toBe(false)
        expect(yield* svc.system()).toEqual([])
      }).pipe(
        provideInstance(projectTmp),
        provideInstruction({ home: globalTmp, config: globalTmp }, { disableClaudeCodePrompt: true }),
      )
    }),
  )
})

describe("Instruction.systemPaths global config", () => {
  it.live("uses Global.Service config ORYNR.md", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "ORYNR.md": "# Global Instructions" })
      const projectTmp = yield* tmpdirScoped()

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, "ORYNR.md"))).toBe(true)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )
})

// A host-path label ("Instructions from: C:\Users\...") leaking into a docker session tells
// the model it is on Windows, so it emits Windows paths/commands inside a Linux container.
// These pin the both-mode behaviour of the path mapping in instruction.ts.
describe("Instruction.system sandbox path safety", () => {
  it.live("docker: a project instruction file is labelled /workspace with no host path", () =>
    Effect.gen(function* () {
      const projectTmp = yield* tmpWithFiles({ "ORYNR.md": "# Project Instructions" }, { git: true })
      yield* Effect.gen(function* () {
        const rules = yield* (yield* Instruction.Service).system()
        expect(rules).toEqual(["Instructions from: /workspace/ORYNR.md\n# Project Instructions"])
        expect(rules[0]).not.toContain(projectTmp) // real host path never appears
        expect(rules[0]).not.toMatch(/[A-Za-z]:\\/) // no Windows drive path
        expect(rules[0]).not.toContain("\\") // no backslashes at all
      }).pipe(provideInstance(projectTmp), provideInstructionDocker({ home: projectTmp, config: projectTmp }))
    }),
  )

  it.live("docker: a host-only global file keeps its guidance but hides its host path", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "ORYNR.md": "# Global Instructions" })
      const projectTmp = yield* tmpdirScoped({ git: true })
      yield* Effect.gen(function* () {
        const rules = yield* (yield* Instruction.Service).system()
        expect(rules).toEqual(["Instructions from: ORYNR.md\n# Global Instructions"])
        expect(rules[0]).not.toContain(globalTmp)
      }).pipe(provideInstance(projectTmp), provideInstructionDocker({ home: globalTmp, config: globalTmp }))
    }),
  )

  it.live("local: the real host path is preserved (no docker remap)", () =>
    Effect.gen(function* () {
      const projectTmp = yield* tmpWithFiles({ "ORYNR.md": "# Project Instructions" }, { git: true })
      yield* Effect.gen(function* () {
        const rules = yield* (yield* Instruction.Service).system()
        expect(rules).toEqual([`Instructions from: ${path.join(projectTmp, "ORYNR.md")}\n# Project Instructions`])
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: projectTmp, config: projectTmp }))
    }),
  )
})
