import { getComponentCatalogue } from "@opentui/solid/components"
import { registerSpinner } from "opentui-spinner/solid"

export function registerOrynrSpinner() {
  if (!getComponentCatalogue().spinner) registerSpinner()
}
