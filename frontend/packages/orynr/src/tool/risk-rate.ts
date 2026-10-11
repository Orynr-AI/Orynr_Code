import * as Tool from "./tool"
import { Schema, Effect } from "effect"
import { RiskAnalyzer } from "@orynr-ai/core/permission/risk"

const Parameters = Schema.Struct({
  tool: Schema.String.annotate({
    description: "The tool being rated, e.g. 'bash', 'edit', 'write', 'read', 'webfetch'.",
  }),
  command: Schema.optional(Schema.String).annotate({
    description: "For bash: the exact shell command to rate.",
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "For edit/write/read: the file path the action touches.",
  }),
})

// Exposes the shared risk classifier to the Risk-Analyzer persona, so its rating and the automatic
// 3-way confirmation gate (Phase 5) are computed by the SAME brain and can never disagree.
export const RiskRateTool = Tool.define(
  "risk_rate",
  Effect.gen(function* () {
    return {
      description:
        "Rate the security risk of a proposed tool action on the shared scale (safe / low / medium / high / critical / unknown). Returns the SAME deterministic verdict the automatic confirmation gate uses, so your assessment always matches what the system would actually do. Pass the tool plus its command (bash) or path (edit/write/read).",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const verdict = RiskAnalyzer.heuristicRate({
            tool: params.tool,
            command: params.command,
            path: params.path,
          })
          yield* ctx.metadata({ title: `risk: ${verdict.level}`, metadata: { level: verdict.level } })
          return {
            output: `${verdict.level.toUpperCase()} — ${verdict.reason}`,
            title: `risk: ${verdict.level}`,
            metadata: { level: verdict.level, reason: verdict.reason },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
