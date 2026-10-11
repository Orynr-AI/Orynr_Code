import type { IntegrationDraft, IntegrationMethodRegistration } from "../effect/integration.js"
import type { CredentialValue } from "@orynr-ai/sdk/v2/types"
import type { Hooks } from "./registration.js"

export type { IntegrationDraft, IntegrationMethodRegistration }

export interface IntegrationHooks extends Hooks<{ transform: IntegrationDraft }> {
  readonly connection: {
    readonly active: (integrationID: string) => Promise<import("@orynr-ai/sdk/v2/types").ConnectionInfo | undefined>
    readonly resolve: (
      connection: import("@orynr-ai/sdk/v2/types").ConnectionInfo,
    ) => Promise<CredentialValue | undefined>
  }
}
