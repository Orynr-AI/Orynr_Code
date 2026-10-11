import { makeGlobalNode } from "@orynr-ai/core/effect/app-node"
import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "@/lsp/lsp"
import { Snapshot } from "../snapshot"
import * as Project from "./project"
import * as Vcs from "./vcs"
import { InstanceState } from "@/effect/instance-state"
import { ShareNext } from "@/share/share-next"
import { Effect, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@orynr-ai/core/cross-spawn-spawner"
import { Config } from "@/config/config"
import { ProjectSetup } from "./setup"
import { Sandbox } from "@/sandbox/sandbox"
import { Service } from "./bootstrap-service"

export { Service } from "./bootstrap-service"
export type { Interface } from "./bootstrap-service"

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Yield each bootstrap dep at layer init so `run` itself has R = never.
    // InstanceStore imports only the lightweight tag from bootstrap-service.ts,
    // so it can depend on bootstrap without importing this implementation graph.
    const config = yield* Config.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const plugin = yield* Plugin.Service
    const project = yield* Project.Service
    const shareNext = yield* ShareNext.Service
    const snapshot = yield* Snapshot.Service
    const vcs = yield* Vcs.Service
    const spawner = yield* ChildProcessSpawner

    const run = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      yield* Effect.logInfo("bootstrapping", { directory: ctx.directory })
      // everything depends on config so eager load it for nice traces
      yield* config.get()
      // Plugin can mutate config so it has to be initialized before anything else.
      yield* plugin.init()
      // Each service self-manages its own slow work via Effect.forkScoped against
      // its per-instance state scope. We just await materialization here.
      yield* Effect.forEach(
        [lsp, shareNext, format, vcs, snapshot, project],
        (s) => s.init().pipe(Effect.catchCause((cause) => Effect.logWarning("init failed", { cause }))),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.withSpan("InstanceBootstrap.init"))
      // Phase 9: run the project's own .orynrcode/setup.sh once (if present + enabled). Safe/skippy.
      yield* ProjectSetup.runSetup(ctx.directory, (yield* config.get()).setup)
      // Install the pre-commit hook wrapper (opt-in: only if .orynrcode/pre-commit.sh exists).
      yield* ProjectSetup.installGitHook(ctx.directory, (yield* config.get()).setup)
      // Docker sandbox: start the project's container NOW (background, best-effort) so
      // "sandbox: docker" means the jail exists immediately, id visible in the UI.
      const sandboxCfg = (yield* config.get()).sandbox
      // Never touch real docker under `bun test`: a test that configures runtime=docker
      // would start a REAL container the test never cleans up. Tests exercise the docker
      // path with mock runners via Sandbox.command directly. ORYNR_TEST comes from
      // test/preload.ts and survives a pre-exported NODE_ENV.
      const dockerAllowed = process.env.NODE_ENV !== "test" && !process.env.ORYNR_TEST
      if (dockerAllowed) {
        // ONE detached fiber, strictly sweep-then-warm: running them in parallel lets
        // the sweep remove the very container warm is about to adopt.
        // The crash-sweep runs in EVERY mode (a crashed docker run leaves containers
        // behind even if the user has since switched to local); warm only in docker mode.
        yield* Effect.forkDetach(
          Effect.promise(() => Sandbox.sweepStale()).pipe(
            Effect.catchCause((cause) => Effect.logWarning("sandbox sweep failed", { cause })),
            Effect.andThen(
              sandboxCfg?.runtime === "docker"
                ? Sandbox.warm({
                    runtime: sandboxCfg.runtime,
                    image: sandboxCfg.image,
                    directory: ctx.directory,
                    runDocker: (args) => spawner.lines(ChildProcess.make("docker", args)),
                  }).pipe(Effect.catchCause((cause) => Effect.logWarning("sandbox warm failed", { cause })))
                : Effect.void,
            ),
          ),
        )
      }
    }).pipe(Effect.withSpan("InstanceBootstrap"))

    return Service.of({ run })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [Config.node, CrossSpawnSpawner.node, Format.node, LSP.node, Plugin.node, Project.node, ShareNext.node, Snapshot.node, Vcs.node],
})

export * as InstanceBootstrap from "./bootstrap"
