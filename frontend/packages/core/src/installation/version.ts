declare global {
  const ORYNR_VERSION: string
  const ORYNR_CHANNEL: string
}

export const InstallationVersion = typeof ORYNR_VERSION === "string" ? ORYNR_VERSION : "local"
// Compile-time define wins; in dev (no define) the ORYNR_CHANNEL env var selects the channel.
export const InstallationChannel = typeof ORYNR_CHANNEL === "string" ? ORYNR_CHANNEL : (process.env["ORYNR_CHANNEL"] ?? "local")
export const InstallationLocal = InstallationChannel === "local"
