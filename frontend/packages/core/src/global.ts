import path from "path"
import fs from "fs/promises"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import os from "os"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"
import { Flag } from "./flag/flag"
import { makeGlobalNode } from "./effect/app-node"

const app = "orynr"

// On Windows Orynr keeps everything in its own AppData folders (settings/plugins/themes in %APPDATA%\Orynr, the rest
// in %LOCALAPPDATA%\Orynr\<data|cache|state>), never ~/.config or ~/.local. An XDG_* variable still wins when set.
// Must match orynr_server/global_paths.py.
const win = process.platform === "win32"
function root(env: string, xdg: string | undefined, kind: "APPDATA" | "LOCALAPPDATA", sub: string) {
  if (process.env[env] || !win) return path.join(xdg!, app)
  const base = process.env[kind] || path.join(os.homedir(), "AppData", kind === "APPDATA" ? "Roaming" : "Local")
  return path.join(base, "Orynr", sub)
}
const data = root("XDG_DATA_HOME", xdgData, "LOCALAPPDATA", "data")
const cache = root("XDG_CACHE_HOME", xdgCache, "LOCALAPPDATA", "cache")
const config = root("XDG_CONFIG_HOME", xdgConfig, "APPDATA", "")
const state = root("XDG_STATE_HOME", xdgState, "LOCALAPPDATA", "state")
const tmp = path.join(os.tmpdir(), app)

const paths = {
  get home() {
    return process.env.ORYNR_TEST_HOME ?? os.homedir()
  },
  data,
  bin: path.join(cache, "bin"),
  log: path.join(data, "log"),
  repos: path.join(data, "repos"),
  cache,
  config,
  state,
  tmp,
}

export const Path = paths

Flock.setGlobal({ state })

await Promise.all([
  fs.mkdir(Path.data, { recursive: true }),
  fs.mkdir(Path.config, { recursive: true }),
  fs.mkdir(Path.state, { recursive: true }),
  fs.mkdir(Path.tmp, { recursive: true }),
  fs.mkdir(Path.log, { recursive: true }),
  fs.mkdir(Path.bin, { recursive: true }),
  fs.mkdir(Path.repos, { recursive: true }),
])

export class Service extends Context.Service<Service, Interface>()("@orynr/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export function make(input: Partial<Interface> = {}): Interface {
  return {
    home: Path.home,
    data: Path.data,
    cache: Path.cache,
    config: Flag.ORYNR_CONFIG_DIR ?? Path.config,
    state: Path.state,
    tmp: Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    ...input,
  }
}

const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(make(input))),
  )

export * as Global from "./global"
