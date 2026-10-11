/**
 * Environment-variable compatibility shim for the orynrcode -> orynr rebrand.
 *
 * The codebase reads ORYNR_* variables, but external setters may still export the
 * legacy ORYNRCODE_* names (old shell profiles, editor extensions, CI scripts, the
 * published SDK server-spawner). Mirroring legacy -> new at process start keeps
 * every one of those working without scattering fallback reads through the code.
 *
 * Import this module FIRST in every process entry point (side-effect only).
 */
const LEGACY_PREFIX = "ORYNRCODE_"
const PREFIX = "ORYNR_"

// Non-prefixed legacy names that don't match the prefix rule.
const LEGACY_MAP: Record<string, string> = {
  _EXTENSION_ORYNRCODE_PORT: "_EXTENSION_ORYNR_PORT",
}

for (const key of Object.keys(process.env)) {
  const target = key.startsWith(LEGACY_PREFIX) ? PREFIX + key.slice(LEGACY_PREFIX.length) : LEGACY_MAP[key]
  if (target && process.env[target] === undefined) process.env[target] = process.env[key]
}

export {}
