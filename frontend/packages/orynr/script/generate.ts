import path from "path"
import { fileURLToPath } from "url"
import { VETTED_CATALOG_URL, vetCatalog } from "@orynr-ai/core/models-dev-filter"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

// The app embeds the engine's vetted catalog, so the app and the engine list exactly the same providers.
// MODELS_DEV_API_JSON (a file) or ORYNR_MODELS_URL (a server) may supply fresher data, limited to that catalog.
const vetted = await Bun.file(VETTED_CATALOG_URL).json()
const override = process.env.MODELS_DEV_API_JSON
  ? await Bun.file(process.env.MODELS_DEV_API_JSON).json()
  : process.env.ORYNR_MODELS_URL
    ? await fetch(`${process.env.ORYNR_MODELS_URL}/api.json`).then((x) => x.json())
    : undefined
export const modelsData = JSON.stringify(override ? vetCatalog(override, vetted) : vetted)
console.log("Loaded models.dev snapshot")
