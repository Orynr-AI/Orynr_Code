import { VETTED_CATALOG_URL, vetCatalog } from "@orynr-ai/core/models-dev-filter"

// Embed the engine's vetted catalog (see packages/orynr/script/generate.ts).
const vetted = await Bun.file(VETTED_CATALOG_URL).json()
const override = process.env.MODELS_DEV_API_JSON
  ? await Bun.file(process.env.MODELS_DEV_API_JSON).json()
  : process.env.ORYNR_MODELS_URL
    ? await fetch(`${process.env.ORYNR_MODELS_URL}/api.json`).then((response) => response.json())
    : undefined

export const modelsData = JSON.stringify(override ? vetCatalog(override, vetted) : vetted)

console.log("Loaded models.dev snapshot")
