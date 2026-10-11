import { Effect } from "effect"
import path from "path"
import { execFile } from "node:child_process"
import { ChildProcess } from "effect/unstable/process"
import { Shell } from "@orynr-ai/core/shell"
import { registerDisposer } from "@/effect/instance-registry"

// Default image for the docker runtime. Must contain `bash`. Overridable via config.sandbox.image.
const DEFAULT_IMAGE = "ubuntu:24.04"

// The container mount point the host project directory is bind-mounted to.
const WORKDIR = "/workspace"

// Process-local memo of container names we've already ensured this run, so we don't
// shell out to `docker ps` on every command (mirrors OpenHands' in-memory process map).
const ensured = new Set<string>()

// A deterministic, docker-valid container name derived from the project directory.
function containerName(root: string) {
  const hash = Buffer.from(root)
    .toString("base64")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-24)
    .toLowerCase()
  return `orynr-sandbox-${hash}`
}

// Docker bind-mount source must use forward slashes and keep the drive letter (Docker Desktop
// accepts `E:/path`); the two-colon `E:\path:/container` form otherwise mis-parses.
function dockerMountSource(root: string) {
  return root.split(path.sep).join("/")
}

// Translate a host path under `root` to its path inside the container's /workspace mount.
function toContainerPath(root: string, hostPath: string) {
  const rel = path.relative(root, hostPath)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return WORKDIR
  return path.posix.join(WORKDIR, rel.split(path.sep).join("/"))
}

// LOCAL command spec — byte-for-byte identical to the original ShellTool cmd().
function localCommand(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }
  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}

// DOCKER command spec — run the command with bash inside the per-session container.
// Host env is intentionally NOT forwarded (isolation); the container keeps its own env.
function dockerCommand(container: string, command: string, containerCwd: string) {
  return ChildProcess.make("docker", ["exec", "-w", containerCwd, container, "bash", "-lc", command], {
    stdin: "ignore",
    detached: false,
  })
}

// Runs `docker <args>` and returns stdout lines. Supplied by the caller (which owns the
// process spawner) so this module needs no Effect services of its own.
export type DockerRunner = (args: string[]) => Effect.Effect<string[], unknown>

function ignoreErr(run: DockerRunner, args: string[]) {
  return run(args).pipe(Effect.catch(() => Effect.succeed([] as string[])))
}

// Remove a container without an Effect context (used by the autostop disposer, which is a plain async fn).
function dockerRemove(name: string): Promise<void> {
  return new Promise((resolve) => {
    execFile("docker", ["rm", "-f", name], () => resolve())
  })
}

// ---------------------------------------------------------------------------
// Crash-safe lifecycle: the disposer above only runs on a GRACEFUL exit. If the
// process is hard-killed (closed window, taskkill, crash) the container would
// linger forever. So every live app touches a keepalive file in its container
// once a minute, and every app start sweeps sandbox containers whose keepalive
// is stale — leftovers self-clean within minutes of the next launch.
// ---------------------------------------------------------------------------
const KEEPALIVE = "/tmp/.orynr-keepalive"
const KEEPALIVE_TTL_SECONDS = 300
const HEARTBEAT_INTERVAL_MS = 60_000

const heartbeats = new Map<string, ReturnType<typeof setInterval>>()

function startHeartbeat(name: string) {
  if (heartbeats.has(name)) return
  const timer = setInterval(() => {
    execFile("docker", ["exec", name, "touch", KEEPALIVE], () => {})
  }, HEARTBEAT_INTERVAL_MS)
  timer.unref?.()
  heartbeats.set(name, timer)
}

function stopHeartbeat(name: string) {
  const timer = heartbeats.get(name)
  if (timer) clearInterval(timer)
  heartbeats.delete(name)
}

function dockerText(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout: 15_000 }, (err, stdout) =>
      resolve({ code: err ? 1 : 0, out: stdout?.toString() ?? "" }),
    )
  })
}

// Remove orphaned sandbox containers (label orynr.sandbox=true) left behind by a
// crashed/killed run: anything this process didn't start whose keepalive is older
// than the TTL. Containers of OTHER live orynr processes have fresh keepalives and
// are spared. Best-effort and silent — docker may not even be installed.
export async function sweepStale(): Promise<void> {
  const list = await dockerText(["ps", "-a", "--filter", "label=orynr.sandbox=true", "--format", "{{.Names}}"])
  if (list.code !== 0) return
  for (const name of list.out.split("\n").map((line) => line.trim()).filter(Boolean)) {
    if (ensured.has(name)) continue
    // Age of the keepalive in seconds, measured with the container's own clock.
    // A missing file (pre-heartbeat container) reads as infinitely old.
    const age = await dockerText([
      "exec", name, "bash", "-c",
      `echo $(( $(date +%s) - $(stat -c %Y ${KEEPALIVE} 2>/dev/null || echo 0) ))`,
    ])
    // exec fails on a stopped container — stopped sandboxes are stale by definition.
    const stale = age.code !== 0 || (Number.parseInt(age.out.trim(), 10) || Number.MAX_SAFE_INTEGER) > KEEPALIVE_TTL_SECONDS
    // Re-check ownership at the last moment: ensureContainer may have adopted this
    // container while we were measuring its age.
    if (stale && !ensured.has(name)) await dockerRemove(name)
  }
}

// AUTOSTOP: register (once) an instance disposer so a project's sandbox container is stopped and
// removed when that instance is torn down (session/app shutdown) — the same lifecycle hook the
// pty cleanup uses. Idempotent: only acts on containers we actually started this run.
let disposerRegistered = false
function ensureDisposer() {
  if (disposerRegistered) return
  disposerRegistered = true
  registerDisposer(async (directory) => {
    const name = containerName(directory)
    if (!ensured.has(name)) return
    ensured.delete(name)
    stopHeartbeat(name)
    await dockerRemove(name)
  })
}

// Start the per-session container if it isn't already running (idempotent). Pulls the image if
// missing, and bind-mounts the project so file tools keep operating on the host copy while
// commands run in the container. Registers autostop on first start.
const ensureContainer = Effect.fn("Sandbox.ensureContainer")(function* (
  run: DockerRunner,
  name: string,
  root: string,
  image: string,
) {
  if (ensured.has(name)) return
  ensureDisposer()
  const running = yield* ignoreErr(run, ["ps", "--filter", `name=^${name}$`, "--format", "{{.Names}}"])
  if (running.some((line) => line.trim() === name)) {
    // Freshen the keepalive BEFORE adopting: a concurrently running crash-sweep must
    // see this container as alive, not as a stale orphan to remove.
    yield* ignoreErr(run, ["exec", name, "touch", KEEPALIVE])
    ensured.add(name)
    startHeartbeat(name)
    return
  }
  // Pull the image if it isn't present locally (docker image inspect fails -> empty -> pull).
  const present = yield* ignoreErr(run, ["image", "inspect", image, "--format", "{{.Id}}"])
  if (present.length === 0) yield* run(["pull", image])
  yield* ignoreErr(run, ["rm", "-f", name])
  yield* run([
    "run",
    "-d",
    "--name",
    name,
    // Real, auditable project<->container binding: inspectable via
    // `docker inspect` / `docker ps --filter label=orynr.project.dir`.
    "--label",
    `orynr.project.dir=${dockerMountSource(root)}`,
    "--label",
    `orynr.sandbox=true`,
    "--label",
    `orynr.image=${image}`,
    "-v",
    `${dockerMountSource(root)}:${WORKDIR}`,
    "-w",
    WORKDIR,
    image,
    // Stamp the keepalive at birth so the crash-sweep can age this container from
    // second one; the per-minute heartbeat keeps it fresh while this app lives.
    "bash",
    "-c",
    `touch ${KEEPALIVE} && exec sleep infinity`,
  ])
  ensured.add(name)
  startHeartbeat(name)
})

// Build the ChildProcess spec for a shell command, honoring the resolved sandbox runtime.
// local (default) -> run on the host exactly as before; docker -> run inside a per-session container.
export const command = Effect.fn("Sandbox.command")(function* (input: {
  runtime: "local" | "docker" | undefined
  image: string | undefined
  directory: string
  shell: string
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  runDocker: DockerRunner
}) {
  if (input.runtime !== "docker") return localCommand(input.shell, input.command, input.cwd, input.env)
  const name = containerName(input.directory)
  yield* ensureContainer(input.runDocker, name, input.directory, input.image ?? DEFAULT_IMAGE).pipe(
    Effect.mapError(
      (cause) =>
        new Error(
          `sandbox: the docker runtime is selected but the container could not be started — ` +
            `is Docker Desktop running? Switch with /sandbox (or \`orynr sandbox local\`). ` +
            `Cause: ${String(cause).slice(0, 200)}`,
        ),
    ),
  )
  return dockerCommand(name, input.command, toContainerPath(input.directory, input.cwd))
})

// Eagerly start the project's container (used at instance bootstrap when the docker
// runtime is active, so "sandbox: docker" means the jail EXISTS now — visible id in the
// UI — rather than materializing lazily on the first command).
export const warm = Effect.fn("Sandbox.warm")(function* (input: {
  runtime: "local" | "docker" | undefined
  image: string | undefined
  directory: string
  runDocker: DockerRunner
}) {
  if (input.runtime !== "docker") return
  const name = containerName(input.directory)
  yield* ensureContainer(input.runDocker, name, input.directory, input.image ?? DEFAULT_IMAGE)
})

// Stop and remove the per-session container for a project directory (best-effort cleanup).
export const teardown = Effect.fn("Sandbox.teardown")(function* (run: DockerRunner, root: string) {
  const name = containerName(root)
  if (!ensured.has(name)) return
  stopHeartbeat(name)
  yield* ignoreErr(run, ["rm", "-f", name])
  ensured.delete(name)
})

export * as Sandbox from "./sandbox"
