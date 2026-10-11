// Orynr ships one vetted provider catalog: the engine's bundled models.dev snapshot
// (orynr_server/assets/models-dev.json), which the app embeds at build time. The live models.dev list also
// carries third-party paid gateways and links that are not ours, so live data is limited to the providers in
// the vetted catalog, and each provider keeps the vetted catalog's own documentation link.

// repo root -> orynr_server/assets/models-dev.json, from any frontend/packages/<pkg>/<dir>/<file>
export const VETTED_CATALOG_URL = new URL("../../../../orynr_server/assets/models-dev.json", import.meta.url)

export function vetCatalog<T extends Record<string, unknown>>(live: T, vetted: Record<string, unknown> | undefined): T {
  if (!vetted) return live
  const out: Record<string, unknown> = {}
  for (const [id, provider] of Object.entries(live)) {
    const known = vetted[id] as { doc?: unknown } | undefined
    if (!known || !provider || typeof provider !== "object") continue
    out[id] = { ...(provider as Record<string, unknown>), doc: known.doc }
  }
  return out as T
}
