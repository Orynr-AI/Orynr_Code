import { Effect } from "effect"
import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "path"

export interface Config {
  readonly enabled?: boolean
  readonly script?: string
  readonly timeout?: number
  readonly hooks?: boolean
}

// Run at most once per project directory per process (a slow setup.sh shouldn't re-run every start).
const ran = new Set<string>()

// Run the project's setup script (default .orynrcode/setup.sh) once at bootstrap, if present + enabled.
// It's the user's OWN script — we just run it with a timeout and log the result. Skips cleanly when
// disabled, missing, already-run, or when bash isn't available (e.g. win32 with no git-bash / a
// headless image). Never fails into the bootstrap path.
export const runSetup = (directory: string, cfg: Config | undefined) =>
  Effect.gen(function* () {
    if (cfg?.enabled === false) return
    if (ran.has(directory)) return
    const rel = cfg?.script ?? path.join(".orynrcode", "setup.sh")
    const scriptPath = path.isAbsolute(rel) ? rel : path.join(directory, rel)
    if (!fs.existsSync(scriptPath)) return
    ran.add(directory)
    const timeoutMs = (cfg?.timeout ?? 600) * 1000
    yield* Effect.logInfo("running project setup script", { scriptPath, timeoutMs })
    const result = yield* Effect.promise(
      () =>
        new Promise<{ ok: boolean; detail: string }>((resolve) => {
          execFile("bash", [scriptPath], { cwd: directory, timeout: timeoutMs }, (err, stdout, stderr) => {
            if (err && (err as NodeJS.ErrnoException).code === "ENOENT")
              resolve({ ok: false, detail: "bash not available — skipped" })
            else if (err) resolve({ ok: false, detail: "failed: " + String(stderr).slice(0, 1500) })
            else resolve({ ok: true, detail: String(stdout).slice(0, 500) })
          })
        }),
    )
    if (result.ok) yield* Effect.logInfo("setup script completed", { stdout: result.detail })
    else yield* Effect.logWarning("setup script skipped/failed", { detail: result.detail })
  })

const HOOK_MARKER = "# orynr-managed pre-commit hook"

// Install a pre-commit hook that runs the project's own .orynrcode/pre-commit.sh. Safe + opt-in: only
// acts when that check script exists and hooks aren't disabled; if a hook is already there it is
// PRESERVED (chained via pre-commit.local), never clobbered. Idempotent. Never throws into bootstrap.
export const installGitHook = (directory: string, cfg: Config | undefined) =>
  Effect.gen(function* () {
    if (cfg?.hooks === false) return
    const result = yield* Effect.sync((): { ok: boolean; msg: string } => {
      try {
        if (!fs.existsSync(path.join(directory, ".git"))) return { ok: false, msg: "not a git repo" }
        const scriptDir = ".orynrcode"
        if (!fs.existsSync(path.join(directory, scriptDir, "pre-commit.sh")))
          return { ok: false, msg: "no .orynrcode/pre-commit.sh to run" }
        const hooksDir = path.join(directory, ".git", "hooks")
        fs.mkdirSync(hooksDir, { recursive: true })
        const hookPath = path.join(hooksDir, "pre-commit")
        let chain = ""
        if (fs.existsSync(hookPath)) {
          const existing = fs.readFileSync(hookPath, "utf8")
          if (existing.includes(HOOK_MARKER)) return { ok: true, msg: "already installed" }
          const localPath = path.join(hooksDir, "pre-commit.local")
          if (!fs.existsSync(localPath)) fs.writeFileSync(localPath, existing, { mode: 0o755 })
          chain = 'if [ -x "$(dirname "$0")/pre-commit.local" ]; then "$(dirname "$0")/pre-commit.local" || exit 1; fi\n'
        }
        const wrapper =
          `#!/bin/sh\n${HOOK_MARKER} — runs ${scriptDir}/pre-commit.sh; any prior hook preserved as pre-commit.local\n` +
          `${chain}if [ -f "${scriptDir}/pre-commit.sh" ]; then sh "${scriptDir}/pre-commit.sh" || exit 1; fi\n`
        fs.writeFileSync(hookPath, wrapper, { mode: 0o755 })
        return { ok: true, msg: "installed" }
      } catch (e) {
        return { ok: false, msg: "error: " + String((e as Error).message ?? e) }
      }
    })
    if (result.ok) yield* Effect.logInfo("git pre-commit hook", { status: result.msg })
    else yield* Effect.logInfo("git pre-commit hook skipped", { reason: result.msg })
  })

export * as ProjectSetup from "./setup"
