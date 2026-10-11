import { Config } from "effect"

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = process.env["ORYNR_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
const fff = process.env["ORYNR_DISABLE_FFF"]

function enabledByExperimental(key: string) {
  return process.env[key] === undefined ? truthy("ORYNR_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  ORYNR_AUTO_HEAP_SNAPSHOT: truthy("ORYNR_AUTO_HEAP_SNAPSHOT"),
  ORYNR_GIT_BASH_PATH: process.env["ORYNR_GIT_BASH_PATH"],
  ORYNR_CONFIG: process.env["ORYNR_CONFIG"],
  ORYNR_CONFIG_CONTENT: process.env["ORYNR_CONFIG_CONTENT"],
  ORYNR_DISABLE_AUTOUPDATE: truthy("ORYNR_DISABLE_AUTOUPDATE"),
  ORYNR_ALWAYS_NOTIFY_UPDATE: truthy("ORYNR_ALWAYS_NOTIFY_UPDATE"),
  ORYNR_DISABLE_PRUNE: truthy("ORYNR_DISABLE_PRUNE"),
  ORYNR_DISABLE_TERMINAL_TITLE: truthy("ORYNR_DISABLE_TERMINAL_TITLE"),
  ORYNR_SHOW_TTFD: truthy("ORYNR_SHOW_TTFD"),
  ORYNR_DISABLE_AUTOCOMPACT: truthy("ORYNR_DISABLE_AUTOCOMPACT"),
  ORYNR_DISABLE_MODELS_FETCH: truthy("ORYNR_DISABLE_MODELS_FETCH"),
  ORYNR_DISABLE_MOUSE: truthy("ORYNR_DISABLE_MOUSE"),
  ORYNR_FAKE_VCS: process.env["ORYNR_FAKE_VCS"],
  ORYNR_SERVER_PASSWORD: process.env["ORYNR_SERVER_PASSWORD"],
  ORYNR_SERVER_USERNAME: process.env["ORYNR_SERVER_USERNAME"],
  ORYNR_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("ORYNR_DISABLE_FFF"),

  // Experimental
  ORYNR_EXPERIMENTAL_FILEWATCHER: Config.boolean("ORYNR_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  ORYNR_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("ORYNR_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  ORYNR_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("ORYNR_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  ORYNR_MODELS_URL: process.env["ORYNR_MODELS_URL"],
  ORYNR_MODELS_PATH: process.env["ORYNR_MODELS_PATH"],
  ORYNR_DB: process.env["ORYNR_DB"],

  ORYNR_WORKSPACE_ID: process.env["ORYNR_WORKSPACE_ID"],
  ORYNR_EXPERIMENTAL_WORKSPACES: enabledByExperimental("ORYNR_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get ORYNR_DISABLE_PROJECT_CONFIG() {
    return truthy("ORYNR_DISABLE_PROJECT_CONFIG")
  },
  get ORYNR_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("ORYNR_EXPERIMENTAL_REFERENCES")
  },
  get ORYNR_TUI_CONFIG() {
    return process.env["ORYNR_TUI_CONFIG"]
  },
  get ORYNR_CONFIG_DIR() {
    return process.env["ORYNR_CONFIG_DIR"]
  },
  get ORYNR_PURE() {
    return truthy("ORYNR_PURE")
  },
  get ORYNR_PERMISSION() {
    return process.env["ORYNR_PERMISSION"]
  },
  get ORYNR_PLUGIN_META_FILE() {
    return process.env["ORYNR_PLUGIN_META_FILE"]
  },
  get ORYNR_CLIENT() {
    return process.env["ORYNR_CLIENT"] ?? "cli"
  },
}
