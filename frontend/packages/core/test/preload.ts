import path from "path"

process.env.ORYNR_DB = ":memory:"
process.env.ORYNR_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.ORYNR_DISABLE_MODELS_FETCH = "true"
