import { describe, expect } from "bun:test"
import { makeGlobalNode } from "@orynr-ai/core/effect/app-node"
import { LayerNode } from "@orynr-ai/core/effect/layer-node"
import { httpClient } from "@orynr-ai/core/effect/app-node-platform"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { InstallationVersion } from "@orynr-ai/core/installation/version"
import { CrossSpawnSpawner } from "@orynr-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

// REBRAND: upstream registry probing/upgrading was deliberately removed (it would
// have reported upstream orynrcode versions and installed upstream orynrcode OVER
// this fork). latest() now reports commits-behind of the source checkout's git
// remote, upgrade() runs `git pull --ff-only` + `bun install`, and every
// registry-based method (npm/brew/scoop/choco/curl/...) fails with guidance.

const encoder = new TextEncoder()

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner(
  handler: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string } = () =>
    "",
) {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const result = handler(std?.command ?? "", std?.args ?? [])
    const output = typeof result === "string" ? { code: 0, stdout: result, stderr: "" } : result
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
        stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function testLayer(
  httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response,
  spawnHandler?: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string },
) {
  const spawnerNode = makeGlobalNode({
    service: ChildProcessSpawner.ChildProcessSpawner,
    layer: mockSpawner(spawnHandler),
    deps: [],
  })
  return LayerNode.compile(Installation.node, [
    [httpClient, mockHttpClient(httpHandler)],
    [CrossSpawnSpawner.node, spawnerNode],
  ])
}

const registryMethods = ["curl", "npm", "yarn", "pnpm", "bun", "brew", "scoop", "choco", "unknown"] as const

const guidance = (method: string) =>
  `orynr has no published distribution channels yet — run it from the source ` +
  `checkout (git pull && bun install). (detected install method: ${method})`

describe("installation", () => {
  describe("latest", () => {
    const behindCalls: string[][] = []
    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          behindCalls.push([cmd, ...args])
          if (cmd === "git" && args[0] === "rev-list") return "3\n"
          return ""
        },
      ),
    ).effect("reports commits-behind of the git remote for source installs", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("source")
        expect(result).toBe(`${InstallationVersion}+3`)
        expect(behindCalls).toContainEqual(["git", "fetch", "--quiet"])
        expect(behindCalls).toContainEqual(["git", "rev-list", "--count", "HEAD..@{upstream}"])
      }),
    )

    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          if (cmd === "git" && args[0] === "rev-list") return "0\n"
          return ""
        },
      ),
    ).effect("returns the current version when the source checkout is up to date", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("source")
        expect(result).toBe(InstallationVersion)
      }),
    )

    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          // e.g. no upstream configured: rev-list produces nothing useful
          if (cmd === "git" && args[0] === "rev-list") return { code: 128, stderr: "fatal: no upstream" }
          return ""
        },
      ),
    ).effect("returns the current version when commits-behind cannot be determined", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("source")
        expect(result).toBe(InstallationVersion)
      }),
    )

    // Registry probing removed: no GitHub-release / npm / brew / scoop / choco
    // lookups, no network at all — every non-source method reports the current
    // version.
    const httpCalls: string[] = []
    const spawnCalls: string[] = []
    testEffect(
      testLayer(
        (request) => {
          httpCalls.push(request.url)
          return jsonResponse({ tag_name: "v9.9.9", version: "9.9.9" })
        },
        (cmd) => {
          spawnCalls.push(cmd)
          return ""
        },
      ),
    ).effect("never probes registries or the network for non-source installs", () =>
      Effect.gen(function* () {
        for (const method of registryMethods) {
          const result = yield* Installation.use.latest(method)
          expect(result).toBe(InstallationVersion)
        }
        expect(httpCalls).toEqual([])
        expect(spawnCalls).toEqual([])
      }),
    )
  })

  describe("upgrade", () => {
    const sourceCalls: string[][] = []
    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          sourceCalls.push([cmd, ...args])
          if (cmd === "git" && args[0] === "pull") return "Already up to date.\n"
          if (cmd === "bun" && args[0] === "install") return "done\n"
          return ""
        },
      ),
    ).effect("upgrades source installs via git pull --ff-only and bun install", () =>
      Effect.gen(function* () {
        yield* Installation.use.upgrade("source", "9.9.9")
        expect(sourceCalls).toContainEqual(["git", "pull", "--ff-only"])
        expect(sourceCalls).toContainEqual(["bun", "install"])
      }),
    )

    const pullFailCalls: string[][] = []
    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          pullFailCalls.push([cmd, ...args])
          if (cmd === "git" && args[0] === "pull")
            return { code: 1, stderr: "fatal: Not possible to fast-forward, aborting." }
          return ""
        },
      ),
    ).effect("fails the source upgrade with git's stderr when the pull cannot fast-forward", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Installation.use.upgrade("source", "9.9.9"))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toBe("fatal: Not possible to fast-forward, aborting.")
        expect(error.message).toBe(error.stderr)
        expect(pullFailCalls).not.toContainEqual(["bun", "install"])
      }),
    )

    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          if (cmd === "git" && args[0] === "pull") return "Already up to date.\n"
          if (cmd === "bun" && args[0] === "install") return { code: 1, stderr: "error: lockfile mismatch" }
          return ""
        },
      ),
    ).effect("fails the source upgrade with bun's stderr when the install fails", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Installation.use.upgrade("source", "9.9.9"))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toBe("error: lockfile mismatch")
      }),
    )

    // The fork has no published distribution channels: every registry-based
    // upgrade path fails with guidance instead of touching the registry.
    const registryHttpCalls: string[] = []
    const registrySpawnCalls: string[] = []
    testEffect(
      testLayer(
        (request) => {
          registryHttpCalls.push(request.url)
          return jsonResponse({})
        },
        (cmd) => {
          registrySpawnCalls.push(cmd)
          return ""
        },
      ),
    ).effect("rejects registry install methods with source-checkout guidance", () =>
      Effect.gen(function* () {
        for (const method of registryMethods) {
          const error = yield* Effect.flip(Installation.use.upgrade(method, "9.9.9"))
          expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
          expect(error.stderr).toBe(guidance(method))
          expect(error.message).toBe(error.stderr)
        }
        expect(registryHttpCalls).toEqual([])
        expect(registrySpawnCalls).toEqual([])
      }),
    )
  })
})
