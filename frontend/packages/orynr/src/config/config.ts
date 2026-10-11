import { LayerNode } from "@orynr-ai/core/effect/layer-node"
import { httpClient } from "@orynr-ai/core/effect/app-node-platform"
import { serviceUse } from "@orynr-ai/core/effect/service-use"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
import { mergeDeep } from "remeda"
import { Global } from "@orynr-ai/core/global"
import fsNode from "fs/promises"
import { Flag } from "@orynr-ai/core/flag/flag"
import { Auth } from "../auth"
import { Env } from "../env"
import { applyEdits, modify } from "jsonc-parser"
import { InstallationLocal, InstallationVersion } from "@orynr-ai/core/installation/version"
import { existsSync } from "fs"
import { Account } from "@/account/account"
import { isRecord } from "@/util/record"
import type { ConsoleState } from "@orynr-ai/core/v1/config/console-state"
import { FSUtil } from "@orynr-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Context, Duration, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { EffectFlock } from "@orynr-ai/core/util/effect-flock"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { ConfigV1 } from "@orynr-ai/core/v1/config/config"
import { RemoteAuthError } from "@orynr-ai/core/v1/config/error"
import { ConfigPermissionV1 } from "@orynr-ai/core/v1/config/permission"
import { ConfigPluginV1 } from "@orynr-ai/core/v1/config/plugin"
import { ConfigAgent } from "./agent"
import { ConfigCommand } from "./command"
import { ConfigManaged } from "./managed"
import { ConfigParse } from "./parse"
import { ConfigPaths } from "./paths"
import { ConfigPlugin } from "./plugin"
import { ConfigVariable } from "./variable"
import { Npm } from "@orynr-ai/core/npm"
import { withTransientReadRetry } from "@/util/effect-http-client"

// Custom merge function that concatenates array fields instead of replacing them
// Keep remeda's deep conditional merge type out of hot config-loading paths; TS profiling showed it dominates here.
function mergeConfig(target: Info, source: Info): Info {
  return mergeDeep(target, source) as Info
}

function mergeConfigConcatArrays(target: Info, source: Info): Info {
  const merged = mergeConfig(target, source)
  if (target.instructions && source.instructions) {
    merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
  }
  return merged
}

function normalizeLoadedConfig(data: unknown) {
  if (!isRecord(data)) return data
  const copy = { ...data }
  const hadLegacy = "theme" in copy || "keybinds" in copy || "tui" in copy
  if (!hadLegacy) return copy
  delete copy.theme
  delete copy.keybinds
  delete copy.tui
  return copy
}

async function substituteWellKnownRemoteConfig(input: {
  value: unknown
  dir: string
  source: string
  env: Record<string, string>
}) {
  if (!isRecord(input.value) || typeof input.value.url !== "string") return undefined

  const url = await ConfigVariable.substitute({
    text: input.value.url,
    type: "virtual",
    dir: input.dir,
    source: input.source,
    env: input.env,
  })
  const headers = isRecord(input.value.headers)
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(input.value.headers)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .map(async ([key, value]) => [
              key,
              await ConfigVariable.substitute({
                text: value,
                type: "virtual",
                dir: input.dir,
                source: input.source,
                env: input.env,
              }),
            ]),
        ),
      )
    : undefined

  return { url, headers }
}

async function resolveLoadedPlugins<T extends { plugin?: ConfigPluginV1.Spec[] }>(config: T, filepath: string) {
  if (!config.plugin) return config
  for (let i = 0; i < config.plugin.length; i++) {
    // Normalize path-like plugin specs while we still know which config file declared them.
    // This prevents `./plugin.ts` from being reinterpreted relative to some later merge location.
    config.plugin[i] = await ConfigPlugin.resolvePluginSpec(config.plugin[i], filepath)
  }
  return config
}

type Info = ConfigV1.Info & {
  // plugin_origins is derived state, not a persisted config field. It keeps each winning plugin spec together
  // with the file and scope it came from so later runtime code can make location-sensitive decisions.
  plugin_origins?: ConfigPlugin.Origin[]
}

type State = {
  config: Info
  directories: string[]
  deps: Fiber.Fiber<void>[]
  consoleState: ConsoleState
}

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  readonly getConsoleState: () => Effect.Effect<ConsoleState>
  readonly update: (config: Info) => Effect.Effect<void>
  readonly updateGlobal: (config: Info) => Effect.Effect<{ info: Info; changed: boolean }>
  readonly invalidate: () => Effect.Effect<void>
  readonly directories: () => Effect.Effect<string[]>
  readonly waitForDependencies: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@orynr/Config") {}

export const use = serviceUse(Service)

// Links node_modules/@orynr-ai/plugin in a config dir to the local workspace package
// (junction on Windows — no admin needed). Best-effort: failures only cost custom-tool
// type imports, never bootstrap.
const ensureLocalPluginLink = Effect.fnUntraced(function* (dir: string) {
  yield* Effect.promise(async () => {
    try {
      const target = path.resolve(new URL("../../../plugin", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"))
      if (!existsSync(target)) return
      const scope = path.join(dir, "node_modules", "@orynr-ai")
      const link = path.join(scope, "plugin")
      if (existsSync(link)) return
      await fsNode.mkdir(scope, { recursive: true })
      await fsNode.symlink(target, link, "junction")
    } catch {}
  })
})

// Quick daemon probe used only when seeding a fresh install's default sandbox runtime.
function dockerAvailable(): Promise<boolean> {
  // Never under `bun test`: every test with a fresh (isolated) config dir would probe the
  // REAL daemon, seed runtime=docker, and eagerly start a REAL container per instance —
  // observed as dozens of leaked ubuntu containers named after test temp dirs.
  // ORYNR_TEST is set by test/preload.ts and survives a pre-exported NODE_ENV.
  if (process.env.NODE_ENV === "test" || process.env.ORYNR_TEST) return Promise.resolve(false)
  return new Promise((resolve) => {
    try {
      const { execFile } = require("child_process") as typeof import("child_process")
      const child = execFile("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 1500 }, (err) =>
        resolve(!err),
      )
      child.on("error", () => resolve(false))
    } catch {
      resolve(false)
    }
  })
}

function globalConfigFile() {
  // New name preferred; legacy orynrcode.json(c)/config.json keep working. Fresh
  // installs seed orynr.jsonc (candidates[0]).
  const candidates = ["orynr.jsonc", "orynr.json", "orynrcode.jsonc", "orynrcode.json", "config.json"].map((file) =>
    path.join(Global.Path.config, file),
  )
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return candidates[0]
}

function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
  if (!isRecord(patch)) {
    const edits = modify(input, path, patch, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    return applyEdits(input, edits)
  }

  return Object.entries(patch).reduce((result, [key, value]) => patchJsonc(result, value, [...path, key]), input)
}

function writable(info: Info) {
  const { plugin_origins: _plugin_origins, ...next } = info
  return next
}

function writableGlobal(info: Info) {
  const next = writable(info)
  // When a user changes config from a value back to default in the Desktop app, we don't want to leave a blank `"shell": "",` key
  if ("shell" in next && next.shell === "") return { ...next, shell: undefined }
  return next
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const authSvc = yield* Auth.Service
    const accountSvc = yield* Account.Service
    const env = yield* Env.Service
    const npmSvc = yield* Npm.Service
    const http = yield* HttpClient.HttpClient

    const readConfigFile = (filepath: string) => fs.readFileStringSafe(filepath).pipe(Effect.orDie)

    const fetchRemoteJson = Effect.fnUntraced(function* <S extends Schema.Top>(
      url: string,
      headers: Record<string, string> | undefined,
      schema: S,
      loginOrigin: string,
    ) {
      const response = yield* HttpClient.filterStatusOk(withTransientReadRetry(http))
        .execute(
          HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.setHeaders(headers ?? {})),
        )
        .pipe(
          Effect.catch((error) => Effect.die(new Error(`failed to fetch remote config from ${url}: ${String(error)}`))),
        )
      const body = yield* response.text.pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to read remote config from ${url}: ${String(error)}`))),
      )
      // An auth proxy can answer with an HTML login page at HTTP 200 (passes filterStatusOk); treat it as a re-auth error, not a decode failure.
      const contentType = (response.headers["content-type"] ?? "").toLowerCase()
      if (contentType.includes("html") || /^\s*<!doctype|^\s*<html/i.test(body)) {
        return yield* Effect.die(new RemoteAuthError({ url: loginOrigin, remote: url }))
      }
      return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to decode remote config from ${url}: ${String(error)}`))),
      )
    })

    const loadConfig = Effect.fnUntraced(function* (
      text: string,
      options: { path: string } | { dir: string; source: string },
      env?: Record<string, string>,
    ) {
      const source = "path" in options ? options.path : options.source
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute(
          "path" in options
            ? { text, type: "path", path: options.path, env }
            : { text, type: "virtual", ...options, env },
        ),
      )
      const parsed = ConfigParse.jsonc(expanded, source)
      const data = ConfigParse.schema(ConfigV1.Info, normalizeLoadedConfig(parsed), source)
      if (!("path" in options)) return data

      yield* Effect.promise(() => resolveLoadedPlugins(data, options.path))
      // NOTE(rebrand): we no longer auto-inject a $schema URL — the upstream
      // orynrcode.ai schema doesn't describe this fork's config (tier/budget/
      // confirmation keys), and there is no hosted orynr schema yet. Existing
      // files that carry the old $schema still load fine (it's just data).
      return data
    })

    const loadFile = Effect.fnUntraced(function* (filepath: string, env?: Record<string, string>) {
      yield* Effect.logInfo("loading", { path: filepath })
      const text = yield* readConfigFile(filepath)
      if (!text) return {} as Info
      return yield* loadConfig(text, { path: filepath }, env)
    })

    const loadGlobal = Effect.fnUntraced(function* (env?: Record<string, string>) {
      let result: Info = {}
      // Seed the default global config on FIRST run only; avoid writing when the user
      // explicitly routes config through env-provided paths or content.
      if (!Flag.ORYNR_CONFIG && !Flag.ORYNR_CONFIG_DIR && !Flag.ORYNR_CONFIG_CONTENT) {
        const file = globalConfigFile()
        if (!existsSync(file)) {
          // Fresh install: default the sandbox to docker when a daemon is reachable
          // (isolated-by-default until the user chooses otherwise), else local. Written
          // explicitly so the choice is visible/editable rather than an invisible default.
          const runtime = (yield* Effect.promise(dockerAvailable)) ? "docker" : "local"
          yield* fs
            .writeWithDirs(file, JSON.stringify({ sandbox: { runtime } }, null, 2))
            .pipe(Effect.catch(() => Effect.void))
        }
      }
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "config.json"), env))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "orynrcode.json"), env))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "orynrcode.jsonc"), env))
      // New-name files merge last so they win over legacy ones.
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "orynr.json"), env))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "orynr.jsonc"), env))

      const legacy = path.join(Global.Path.config, "config")
      if (existsSync(legacy)) {
        yield* Effect.promise(() =>
          import(pathToFileURL(legacy).href, { with: { type: "toml" } })
            .then(async (mod) => {
              const { provider, model, ...rest } = mod.default
              if (provider && model) result.model = `${provider}/${model}`
              result = mergeConfig(result, rest)
              await fsNode.writeFile(path.join(Global.Path.config, "config.json"), JSON.stringify(result, null, 2))
              await fsNode.unlink(legacy)
            })
            .catch(() => {}),
        )
      }

      return result
    })

    const [cachedGlobal, invalidateGlobal] = yield* Effect.cachedInvalidateWithTTL(
      loadGlobal().pipe(
        Effect.tapError((error) =>
          Effect.logError("failed to load global config, using defaults", { error: String(error) }),
        ),
        Effect.orElseSucceed((): Info => ({})),
      ),
      Duration.infinity,
    )

    const getGlobal = Effect.fn("Config.getGlobal")(function* () {
      return yield* cachedGlobal
    })

    const ensureGitignore = Effect.fn("Config.ensureGitignore")(function* (dir: string) {
      yield* fs.ensureDir(dir)
      const gitignore = path.join(dir, ".gitignore")
      const hasIgnore = yield* fs.existsSafe(gitignore)
      if (!hasIgnore) {
        yield* fs
          .writeFileString(
            gitignore,
            ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n"),
          )
          .pipe(
            Effect.catchIf(
              (e) => e.reason._tag === "PermissionDenied",
              () => Effect.void,
            ),
          )
      }
    })

    const loadInstanceState = Effect.fn("Config.loadInstanceState")(
      function* (ctx: InstanceContext) {
        const auth = yield* authSvc.all().pipe(Effect.orDie)

        let result: Info = {}
        const authEnv: Record<string, string> = {}
        const consoleManagedProviders = new Set<string>()
        let activeOrgName: string | undefined

        const pluginScopeForSource = Effect.fnUntraced(function* (source: string) {
          if (source.startsWith("http://") || source.startsWith("https://")) return "global"
          if (source === "ORYNR_CONFIG_CONTENT") return "local"
          if (containsPath(source, ctx)) return "local"
          return "global"
        })

        const mergePluginOrigins = Effect.fnUntraced(function* (
          source: string,
          // mergePluginOrigins receives raw Specs from one config source, before provenance for this merge step
          // is attached.
          list: ConfigPluginV1.Spec[] | undefined,
          // Scope can be inferred from the source path, but some callers already know whether the config should
          // behave as global or local and can pass that explicitly.
          kind?: ConfigPlugin.Scope,
        ) {
          if (!list?.length) return
          const hit = kind ?? (yield* pluginScopeForSource(source))
          // Merge newly seen plugin origins with previously collected ones, then dedupe by plugin identity while
          // keeping the winning source/scope metadata for downstream installs, writes, and diagnostics.
          const plugins = ConfigPlugin.deduplicatePluginOrigins([
            ...(result.plugin_origins ?? []),
            ...list.map((spec) => ({ spec, source, scope: hit })),
          ])
          result.plugin = plugins.map((item) => item.spec)
          result.plugin_origins = plugins
        })

        const merge = (source: string, next: Info, kind?: ConfigPlugin.Scope) => {
          result = mergeConfigConcatArrays(result, next)
          return mergePluginOrigins(source, next.plugin, kind)
        }

        for (const [key, value] of Object.entries(auth)) {
          if (value.type === "wellknown") {
            const url = key.replace(/\/+$/, "")
            authEnv[value.key] = value.token
            const wellknownURL = `${url}/.well-known/orynrcode`
            yield* Effect.logDebug("fetching remote config", { url: wellknownURL })
            const wellknown = yield* fetchRemoteJson(wellknownURL, undefined, ConfigV1.WellKnown, url)
            const remote = yield* Effect.promise(() =>
              substituteWellKnownRemoteConfig({
                value: wellknown.remote_config,
                dir: url,
                source: wellknownURL,
                env: authEnv,
              }),
            )
            const fetchedConfig = remote
              ? yield* Effect.gen(function* () {
                  yield* Effect.logDebug("fetching remote config", { url: remote.url })
                  const data = yield* fetchRemoteJson(remote.url, remote.headers, Schema.Json, url)
                  if (isRecord(data) && isRecord(data.config)) return data.config
                  if (isRecord(data)) return data
                  return yield* Effect.die(
                    new Error(`failed to decode remote config from ${remote.url}: expected object`),
                  )
                })
              : {}
            const remoteConfig = mergeConfig(isRecord(wellknown.config) ? wellknown.config : {}, fetchedConfig)
            const source = wellknownURL
            const next = yield* loadConfig(
              JSON.stringify(remoteConfig),
              {
                dir: path.dirname(source),
                source,
              },
              authEnv,
            )
            yield* merge(source, next, "global")
            yield* Effect.logDebug("loaded remote config from well-known", { url })
          }
        }

        const global = Object.keys(authEnv).length ? yield* loadGlobal(authEnv) : yield* getGlobal()
        yield* merge(Global.Path.config, global, "global")

        if (Flag.ORYNR_CONFIG) {
          yield* merge(Flag.ORYNR_CONFIG, yield* loadFile(Flag.ORYNR_CONFIG, authEnv))
          yield* Effect.logDebug("loaded custom config", { path: Flag.ORYNR_CONFIG })
        }

        if (!Flag.ORYNR_DISABLE_PROJECT_CONFIG) {
          // orynrcode.json(c) first, orynr.json(c) after — the orynr name wins on merge.
          for (const name of ["orynrcode", "orynr"]) {
            for (const file of yield* ConfigPaths.files(name, ctx.directory, ctx.worktree).pipe(Effect.orDie)) {
              yield* merge(file, yield* loadFile(file, authEnv), "local")
            }
          }
        }

        result.agent = result.agent || {}
        result.mode = result.mode || {}
        result.plugin = result.plugin || []

        const directories = yield* ConfigPaths.directories(ctx.directory, ctx.worktree)

        if (Flag.ORYNR_CONFIG_DIR) {
          yield* Effect.logDebug("loading config from ORYNR_CONFIG_DIR", { path: Flag.ORYNR_CONFIG_DIR })
        }

        const deps: Fiber.Fiber<void>[] = []

        for (const dir of directories) {
          if (dir.endsWith(".orynrcode") || dir === Flag.ORYNR_CONFIG_DIR) {
            for (const file of ["orynrcode.json", "orynrcode.jsonc", "orynr.json", "orynr.jsonc"]) {
              const source = path.join(dir, file)
              yield* Effect.logDebug(`loading config from ${source}`)
              yield* merge(source, yield* loadFile(source, authEnv))
              result.agent ??= {}
              result.mode ??= {}
              result.plugin ??= []
            }
          }

          yield* ensureGitignore(dir).pipe(Effect.orDie)

          // Source-built fork: @orynr-ai/plugin is not on the npm registry, so local runs
          // link the workspace package into the config dir instead of npm-installing it —
          // its workspace:*/catalog: deps then resolve from the repo like any workspace pkg.
          if (InstallationLocal) yield* ensureLocalPluginLink(dir)

          const dep = yield* npmSvc
            .install(dir, {
              add: InstallationLocal
                ? []
                : [
                    {
                      name: "@orynr-ai/plugin",
                      version: InstallationVersion,
                    },
                  ],
            })
            .pipe(
              Effect.exit,
              Effect.tap((exit) =>
                Exit.isFailure(exit)
                  ? Effect.logWarning("background dependency install failed", { dir, error: String(exit.cause) })
                  : Effect.void,
              ),
              Effect.asVoid,
              Effect.forkDetach,
            )
          deps.push(dep)

          result.command = mergeDeep(result.command ?? {}, yield* Effect.promise(() => ConfigCommand.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.loadMode(dir)))
          // Auto-discovered plugins under `.orynrcode/plugin(s)` are already local files, so ConfigPlugin.load
          // returns normalized Specs and we only need to attach origin metadata here.
          const list = yield* Effect.promise(() => ConfigPlugin.load(dir))
          yield* mergePluginOrigins(dir, list)
        }

        if (process.env.ORYNR_CONFIG_CONTENT) {
          const source = "ORYNR_CONFIG_CONTENT"
          const next = yield* loadConfig(process.env.ORYNR_CONFIG_CONTENT, {
            dir: ctx.directory,
            source,
          })
          yield* merge(source, next, "local")
          yield* Effect.logDebug("loaded custom config from ORYNR_CONFIG_CONTENT")
        }

        const activeAccount = Option.getOrUndefined(
          yield* accountSvc.active().pipe(Effect.catch(() => Effect.succeed(Option.none()))),
        )
        if (activeAccount?.active_org_id) {
          const accountID = activeAccount.id
          const orgID = activeAccount.active_org_id
          const url = activeAccount.url
          yield* Effect.gen(function* () {
            const [configOpt, tokenOpt] = yield* Effect.all(
              [accountSvc.config(accountID, orgID), accountSvc.token(accountID)],
              { concurrency: 2 },
            )
            if (Option.isSome(tokenOpt)) {
              process.env["ORYNR_CONSOLE_TOKEN"] = tokenOpt.value
              yield* env.set("ORYNR_CONSOLE_TOKEN", tokenOpt.value)
            }

            if (Option.isSome(configOpt)) {
              const source = `${url}/api/config`
              const next = yield* loadConfig(JSON.stringify(configOpt.value), {
                dir: path.dirname(source),
                source,
              })
              for (const providerID of Object.keys(next.provider ?? {})) {
                consoleManagedProviders.add(providerID)
              }
              yield* merge(source, next, "global")
            }
          }).pipe(
            Effect.withSpan("Config.loadActiveOrgConfig"),
            Effect.catch((err) =>
              Effect.logDebug("failed to fetch remote account config", {
                error: err instanceof Error ? err.message : String(err),
              }),
            ),
          )
        }

        const managedDir = ConfigManaged.managedConfigDir()
        if (existsSync(managedDir)) {
          for (const file of ["orynrcode.json", "orynrcode.jsonc"]) {
            const source = path.join(managedDir, file)
            yield* merge(source, yield* loadFile(source), "global")
          }
        }

        // macOS managed preferences (.mobileconfig deployed via MDM) override everything
        const managed = yield* Effect.promise(() => ConfigManaged.readManagedPreferences())
        if (managed) {
          result = mergeConfigConcatArrays(
            result,
            yield* loadConfig(managed.text, {
              dir: path.dirname(managed.source),
              source: managed.source,
            }),
          )
        }

        for (const [name, mode] of Object.entries(result.mode ?? {})) {
          result.agent = mergeDeep(result.agent ?? {}, {
            [name]: {
              ...mode,
              mode: "primary" as const,
            },
          })
        }

        if (Flag.ORYNR_PERMISSION) {
          try {
            result.permission = mergeDeep(result.permission ?? {}, JSON.parse(Flag.ORYNR_PERMISSION))
          } catch (err) {
            yield* Effect.logWarning("ORYNR_PERMISSION contains invalid JSON, skipping", { err })
          }
        }

        if (result.tools) {
          const perms: Record<string, ConfigPermissionV1.Action> = {}
          for (const [tool, enabled] of Object.entries(result.tools)) {
            const action: ConfigPermissionV1.Action = enabled ? "allow" : "deny"
            if (tool === "write" || tool === "edit" || tool === "patch") {
              perms.edit = action
              continue
            }
            perms[tool] = action
          }
          result.permission = mergeDeep(perms, result.permission ?? {})
        }

        if (!result.username) {
          try {
            result.username = os.userInfo().username || "user"
          } catch (err) {
            yield* Effect.logWarning("failed to read system username, using fallback", { err })
            result.username = "user"
          }
        }

        if (result.autoshare === true && !result.share) {
          result.share = "auto"
        }

        if (Flag.ORYNR_DISABLE_AUTOCOMPACT) {
          result.compaction = { ...result.compaction, auto: false }
        }
        if (Flag.ORYNR_DISABLE_PRUNE) {
          result.compaction = { ...result.compaction, prune: false }
        }

        return {
          config: result,
          directories,
          deps,
          consoleState: {
            consoleManagedProviders: Array.from(consoleManagedProviders),
            activeOrgName,
            switchableOrgCount: 0,
          },
        }
      },
      Effect.provideService(FSUtil.Service, fs),
    )

    const state = yield* InstanceState.make<State>(
      Effect.fn("Config.state")(function* (ctx) {
        return yield* loadInstanceState(ctx).pipe(Effect.orDie)
      }),
    )

    const get = Effect.fn("Config.get")(function* () {
      return yield* InstanceState.use(state, (s) => s.config)
    })

    const directories = Effect.fn("Config.directories")(function* () {
      return yield* InstanceState.use(state, (s) => s.directories)
    })

    const getConsoleState = Effect.fn("Config.getConsoleState")(function* () {
      return yield* InstanceState.use(state, (s) => s.consoleState)
    })

    const waitForDependencies = Effect.fn("Config.waitForDependencies")(function* () {
      yield* InstanceState.useEffect(state, (s) =>
        Effect.forEach(s.deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.asVoid),
      )
    })

    const update = Effect.fn("Config.update")(function* (config: Info) {
      const dir = yield* InstanceState.directory
      // BUG FIX: this used to write <dir>/config.json — a filename the project loader
      // never reads, so instance updates vanished into an unread file. Patch the project
      // config file the loader actually loads: an existing orynr/orynrcode json(c) file,
      // defaulting to orynr.json for fresh projects.
      const candidates = ["orynr.json", "orynr.jsonc", "orynrcode.json", "orynrcode.jsonc"].map((name) =>
        path.join(dir, name),
      )
      const file = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
      const patch = writable(config)
      if (file.endsWith(".jsonc")) {
        const before = (yield* readConfigFile(file)) ?? "{}"
        yield* fs.writeFileString(file, patchJsonc(before, patch)).pipe(Effect.orDie)
      } else {
        const existing = yield* loadFile(file)
        yield* fs
          .writeFileString(file, JSON.stringify(mergeDeep(writable(existing), patch), null, 2))
          .pipe(Effect.orDie)
      }
    })

    const invalidate = Effect.fn("Config.invalidate")(function* () {
      yield* invalidateGlobal
    })

    const updateGlobal = Effect.fn("Config.updateGlobal")(function* (config: Info) {
      const file = globalConfigFile()
      const before = (yield* readConfigFile(file)) ?? "{}"
      const patch = writableGlobal(config)

      let next: Info
      let changed: boolean
      if (!file.endsWith(".jsonc")) {
        const existing = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(before, file), file)
        const merged = mergeDeep(writable(existing), patch)
        const serialized = JSON.stringify(merged, null, 2)
        changed = serialized !== before
        if (changed) yield* fs.writeFileString(file, serialized).pipe(Effect.orDie)
        next = merged
      } else {
        const updated = patchJsonc(before, patch)
        next = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(updated, file), file)
        changed = updated !== before
        if (changed) yield* fs.writeFileString(file, updated).pipe(Effect.orDie)
      }

      if (changed) yield* invalidate()
      return { info: next, changed }
    })

    return Service.of({
      get,
      getGlobal,
      getConsoleState,
      update,
      updateGlobal,
      invalidate,
      directories,
      waitForDependencies,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Auth.node, Account.node, Env.node, Npm.node, httpClient],
})

export * as Config from "./config"
