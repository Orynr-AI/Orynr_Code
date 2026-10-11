import { LayerNode } from "@orynr-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@orynr-ai/core/effect/app-node-builder"
import { httpClient } from "@orynr-ai/core/effect/app-node-platform"
import { Effect, Layer, Schema, Context, Stream } from "effect"
import { serviceUse } from "@orynr-ai/core/effect/service-use"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { errorMessage } from "@/util/error"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@orynr-ai/core/process"
import path from "path"
import { makeRuntime } from "@orynr-ai/core/effect/runtime"
import semver from "semver"
import { InstallationChannel, InstallationLocal, InstallationVersion } from "@orynr-ai/core/installation/version"
import { NpmConfig } from "@orynr-ai/core/npm-config"
import { InstallationEvent } from "@orynr-ai/schema/installation-event"

export type Method = "source" | "curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"

// Git checkout containing this source tree (the normal install for the fork), or undefined
// when running from a compiled binary. Cached: the answer can't change within a process.
let sourceRepoDirCache: string | undefined | null = null
function sourceRepoDirSync(): string | undefined {
  if (sourceRepoDirCache !== null) return sourceRepoDirCache
  sourceRepoDirCache = undefined
  try {
    const { fileURLToPath } = require("url") as typeof import("url")
    const { execFileSync } = require("child_process") as typeof import("child_process")
    const here = fileURLToPath(new URL(".", import.meta.url))
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: here, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
    if (top) sourceRepoDirCache = top
  } catch {}
  return sourceRepoDirCache
}

export type ReleaseType = "patch" | "minor" | "major"

export const Event = InstallationEvent

export function getReleaseType(current: string, latest: string): ReleaseType {
  const currMajor = semver.major(current)
  const currMinor = semver.minor(current)
  const newMajor = semver.major(latest)
  const newMinor = semver.minor(latest)

  if (newMajor > currMajor) return "major"
  if (newMinor > currMinor) return "minor"
  return "patch"
}

export const Info = Schema.Struct({
  version: Schema.String,
  latest: Schema.String,
}).annotate({ identifier: "InstallationInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export function userAgent(client = "cli") {
  return `orynr/${InstallationChannel}/${InstallationVersion}/${client}`
}

export const USER_AGENT = userAgent()

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {
  override get message() {
    return this.stderr
  }
}

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method) => Effect.Effect<string>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@orynr/Installation") {}

export const use = serviceUse(Service)

const layer: Layer.Layer<Service, never, HttpClient.HttpClient | AppProcess.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(withTransientReadRetry(http))
    const appProcess = yield* AppProcess.Service

    const text = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return result.stdout.toString("utf8")
      },
      Effect.catch(() => Effect.succeed("")),
    )

    const run = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return {
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      },
      Effect.catch((err) => Effect.succeed({ code: 1, stdout: "", stderr: errorMessage(err) })),
    )

    const result: Interface = {
      info: Effect.fn("Installation.info")(function* () {
        return {
          version: InstallationVersion,
          latest: yield* result.latest(),
        }
      }),
      method: Effect.fn("Installation.method")(function* () {
        // Source checkout (the normal way to run this fork): upgrade via git.
        if (InstallationLocal && sourceRepoDirSync()) return "source" as Method
        // Orynrcode manages only itself: detection looks for ORYNR installs exclusively.
        // (Upstream orynrcode installs on the same machine are a different program — not ours to find or touch.)
        if (process.execPath.includes(path.join(".orynr", "bin"))) return "curl" as Method
        if (process.execPath.includes(path.join(".local", "bin"))) return "curl" as Method
        const exec = process.execPath.toLowerCase()

        const checks: Array<{ name: Method; command: () => Effect.Effect<string> }> = [
          { name: "npm", command: () => text(["npm", "list", "-g", "--depth=0"]) },
          { name: "yarn", command: () => text(["yarn", "global", "list"]) },
          { name: "pnpm", command: () => text(["pnpm", "list", "-g", "--depth=0"]) },
          { name: "bun", command: () => text(["bun", "pm", "ls", "-g"]) },
          { name: "brew", command: () => text(["brew", "list", "--formula", "orynr"]) },
          { name: "scoop", command: () => text(["scoop", "list", "orynr"]) },
          { name: "choco", command: () => text(["choco", "list", "--limit-output", "orynr"]) },
        ]

        checks.sort((a, b) => {
          const aMatches = exec.includes(a.name)
          const bMatches = exec.includes(b.name)
          if (aMatches && !bMatches) return -1
          if (!aMatches && bMatches) return 1
          return 0
        })

        for (const check of checks) {
          const output = yield* check.command()
          const installedName = check.name === "brew" || check.name === "choco" || check.name === "scoop" ? "orynr" : "orynr-ai"
          if (output.includes(installedName)) {
            return check.name
          }
        }

        return "unknown" as Method
      }),
      // REBRAND: upstream registry probing removed (it would have reported upstream
      // versions and installed upstream orynrcode OVER this fork). The fork upgrades
      // from its own git remote: latest() reports how far behind origin we are, and
      // upgrade() runs git pull --ff-only + bun install in the checkout.
      latest: Effect.fn("Installation.latest")(function* (installMethod?: Method) {
        const detectedMethod = installMethod || (yield* result.method())
        if (detectedMethod === "source") {
          const dir = sourceRepoDirSync()
          if (dir) {
            yield* run(["git", "fetch", "--quiet"], { cwd: dir })
            const behind = yield* run(["git", "rev-list", "--count", "HEAD..@{upstream}"], { cwd: dir })
            const count = Number.parseInt(behind.stdout.trim(), 10)
            if (Number.isFinite(count) && count > 0) return `${InstallationVersion}+${count}`
          }
        }
        return InstallationVersion
      }, Effect.orDie),
      upgrade: Effect.fn("Installation.upgrade")(function* (m: Method, _target: string) {
        if (m === "source") {
          const dir = sourceRepoDirSync()
          if (!dir) return yield* new UpgradeFailedError({ stderr: "source checkout not found" })
          const pull = yield* run(["git", "pull", "--ff-only"], { cwd: dir })
          if (pull.code !== 0) return yield* new UpgradeFailedError({ stderr: pull.stderr || pull.stdout })
          const install = yield* run(["bun", "install"], { cwd: dir })
          if (install.code !== 0) return yield* new UpgradeFailedError({ stderr: install.stderr || install.stdout })
          yield* Effect.logInfo("upgraded from source", { dir })
          return
        }
        return yield* new UpgradeFailedError({
          stderr:
            `orynr has no published distribution channels yet — run it from the source ` +
            `checkout (git pull && bun install). (detected install method: ${m})`,
        })
      }),
    }

    return Service.of(result)
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [httpClient, AppProcess.node] })

const { runPromise } = makeRuntime(Service, AppNodeBuilder.build(node))

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
export const upgrade = (...args: Parameters<Interface["upgrade"]>) => runPromise((s) => s.upgrade(...args))

export * as Installation from "."
