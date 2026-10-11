import type { Config } from "@/config/config"
import { ConfigV1 } from "@orynr-ai/core/v1/config/config"
import { SessionV1 } from "@orynr-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
  count?: number
}) {
  // mode:"off" is the faithful NoOp — never proactively compact; keep full history and let a genuine
  // token overflow surface as a normal model error instead.
  if (input.cfg.compaction?.mode === "off") return false
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  // Proactive message-count trigger (LLMSummarizingCondenser max_size analog): compact once the
  // conversation grows past max_size messages, before token overflow.
  const maxSize = input.cfg.compaction?.max_size
  if (maxSize != null && input.count != null && input.count >= maxSize) return true

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}
