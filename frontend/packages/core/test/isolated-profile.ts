// Test preload: point every Orynr data/config/cache/state dir (and the app's notion of
// "home") at a throwaway temp folder, so no test run can touch the real user profile.
// Must run before anything imports @orynr-ai/core/global (xdg-basedir reads env at import).
import fs from "fs"
import os from "os"
import path from "path"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orynr-test-profile-"))
const home = path.join(root, "home")
fs.mkdirSync(home, { recursive: true })

process.env.XDG_DATA_HOME = path.join(root, "share")
process.env.XDG_CACHE_HOME = path.join(root, "cache")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.XDG_STATE_HOME = path.join(root, "state")
process.env.ORYNR_TEST_HOME = home
process.env.ORYNR_TEST_MANAGED_CONFIG_DIR = path.join(root, "managed")

process.on("exit", () => {
  // Best effort: on Windows a still-open SQLite handle can keep a file busy until exit.
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {}
})
