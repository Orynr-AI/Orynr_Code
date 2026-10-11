export * as ConfigManaged from "./managed"

import { existsSync } from "fs"
import os from "os"
import path from "path"
import { Process } from "@/util/process"

// Managed/MDM deployment identity. New deployments should use the orynr names; the
// legacy orynrcode names keep working so machines managed before the rebrand don't
// silently lose their policy.
const MANAGED_PLIST_DOMAINS = ["ai.orynr.managed"]

// Keys injected by macOS/MDM into the managed plist that are not Orynrcode config
const PLIST_META = new Set([
  "PayloadDisplayName",
  "PayloadIdentifier",
  "PayloadType",
  "PayloadUUID",
  "PayloadVersion",
  "_manualProfile",
])

function systemManagedConfigDirs(): string[] {
  switch (process.platform) {
    case "darwin":
      return ["/Library/Application Support/orynr", "/Library/Application Support/orynrcode"]
    case "win32": {
      const programData = process.env.ProgramData || "C:\\ProgramData"
      return [path.join(programData, "orynr")]
    }
    default:
      return ["/etc/orynr", "/etc/orynrcode"]
  }
}

export function managedConfigDir() {
  if (process.env.ORYNR_TEST_MANAGED_CONFIG_DIR) return process.env.ORYNR_TEST_MANAGED_CONFIG_DIR
  const dirs = systemManagedConfigDirs()
  return dirs.find((dir) => existsSync(dir)) ?? dirs[0]
}

export function parseManagedPlist(json: string): string {
  const raw = JSON.parse(json)
  for (const key of Object.keys(raw)) {
    if (PLIST_META.has(key)) delete raw[key]
  }
  return JSON.stringify(raw)
}

export async function readManagedPreferences() {
  if (process.platform !== "darwin") return

  const user = (() => {
    try {
      return os.userInfo().username || "user"
    } catch {
      return "user"
    }
  })()
  const paths = MANAGED_PLIST_DOMAINS.flatMap((domain) => [
    path.join("/Library/Managed Preferences", user, `${domain}.plist`),
    path.join("/Library/Managed Preferences", `${domain}.plist`),
  ])

  for (const plist of paths) {
    if (!existsSync(plist)) continue
    const result = await Process.run(["plutil", "-convert", "json", "-o", "-", plist], { nothrow: true })
    if (result.code !== 0) continue
    return {
      source: `mobileconfig:${plist}`,
      text: parseManagedPlist(result.stdout.toString()),
    }
  }

  return
}
