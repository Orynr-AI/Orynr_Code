import path from "path"
import { SessionV1 } from "@orynr-ai/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { FSUtil } from "@orynr-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"
import PROMPT_CODE_ANALYZER from "./prompt/code-analyzer.txt"
import PROMPT_AUTONOMOUS from "./prompt/autonomous.txt"
import PROMPT_RALPH from "./prompt/ralph.txt"
import PROMPT_CHAT from "./prompt/chat.txt"
import PROMPT_CHARACTER from "./prompt/character.txt"
import PROMPT_RISK_ANALYZER from "./prompt/risk-analyzer.txt"
import PROMPT_RESEARCH from "./prompt/research.txt"
import PROMPT_THINKING from "./prompt/thinking.txt"

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  const flags = yield* RuntimeFlags.Service
  const fsys = yield* FSUtil.Service
  const sessions = yield* Session.Service
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages

  // Phase 10: inject any skills triggered by this message (keyword match or type:"always") as
  // EXTRA_INFO, before the mode persona. `available` already filters by the agent's skill permission
  // (Chat's *:deny yields none), so the router never gets skill noise.
  const skillsvc = yield* Skill.Service
  const userText = userMessage.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as Record<string, unknown>).text as string)
    .filter((t) => typeof t === "string")
    .join("\n")
  for (const sk of Skill.activated(yield* skillsvc.available(input.agent), userText)) {
    userMessage.parts.push({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: `<EXTRA_INFO source="skill:${sk.name}">\n${sk.content}\n</EXTRA_INFO>`,
      synthetic: true,
    })
  }

  if (input.agent.name === "code-analyzer") {
    userMessage.parts.push({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: PROMPT_CODE_ANALYZER,
      synthetic: true,
    })
    return input.messages
  }

  if (input.agent.name === "autonomous") {
    userMessage.parts.push({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: PROMPT_AUTONOMOUS,
      synthetic: true,
    })
    return input.messages
  }

  if (input.agent.name === "ralph") {
    userMessage.parts.push({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: PROMPT_RALPH,
      synthetic: true,
    })
    return input.messages
  }

  if (input.agent.name === "chat" || input.agent.name === "risk-analyzer" || input.agent.name === "character") {
    userMessage.parts.push({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text:
        input.agent.name === "chat"
          ? PROMPT_CHAT
          : input.agent.name === "character"
            ? PROMPT_CHARACTER
            : PROMPT_RISK_ANALYZER,
      synthetic: true,
    })
    return input.messages
  }

  if (input.agent.name === "research" || input.agent.name === "thinking") {
    const opts = (input.agent.options ?? {}) as Record<string, unknown>
    const auto = opts.auto === true
    const level = typeof opts.level === "string" ? opts.level.toUpperCase() : "MEDIUM"
    const levelDirective = auto
      ? "AUTO-ESCALATE is ON: judge this task's complexity yourself and apply the matching depth level (a simple lookup -> LOW; a deep, open-ended, or high-stakes task -> ULTRA; default to at least MEDIUM). State which level you chose and why before you begin."
      : `ACTIVE LEVEL: ${level}. Operate strictly at this level for this task.`
    const base = input.agent.name === "research" ? PROMPT_RESEARCH : PROMPT_THINKING
    userMessage.parts.push({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: base.replace("${levelDirective}", () => levelDirective),
      synthetic: true,
    })
    return input.messages
  }

  if (!flags.experimentalPlanMode) {
    if (input.agent.name === "plan") {
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: PROMPT_PLAN,
        synthetic: true,
      })
    }
    const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
    if (wasPlan && input.agent.name === "build") {
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: BUILD_SWITCH,
        synthetic: true,
      })
    }
    return input.messages
  }

  const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
  if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
    const ctx = yield* InstanceState.context
    const plan = Session.plan(input.session, ctx)
    const exists = yield* fsys.existsSafe(plan)
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: exists
        ? `${BUILD_SWITCH}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`
        : BUILD_SWITCH,
      synthetic: true,
    })
    userMessage.parts.push(part)
    return input.messages
  }

  if (input.agent.name !== "plan" || assistantMessage?.info.agent === "plan") return input.messages

  const ctx = yield* InstanceState.context
  const plan = Session.plan(input.session, ctx)
  const exists = yield* fsys.existsSafe(plan)
  if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text: PLAN_MODE.replace("${planInfo}", () =>
      exists
        ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`
        : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
    ),
    synthetic: true,
  })
  userMessage.parts.push(part)
  return input.messages
})

export * as SessionReminders from "./reminders"
