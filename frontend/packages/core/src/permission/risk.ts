// Shared security-risk classifier. ONE unified severity scale, computed by ONE function, consumed by
// BOTH the user-facing Risk-Analyzer mode (via the risk_rate tool) and the 3-way confirmation gate
// (Phase 5). Keeping both consumers on the same rate() is what stops the "manual check says X, auto
// gate says Y" drift. This deterministic heuristic is the reproducible floor; an optional LLM layer
// (Phase 11) may only ESCALATE a verdict, never soften it.

export type Level = "safe" | "low" | "medium" | "high" | "critical" | "unknown"

// Numeric height for threshold comparison. `unknown` sits at medium height, but the gate treats it as
// fail-closed (escalates to "ask" under the 'risky' policy) regardless of this number.
export const RANK: Record<Level, number> = {
  safe: 0,
  low: 1,
  unknown: 2,
  medium: 2,
  high: 3,
  critical: 4,
}

export interface Verdict {
  readonly level: Level
  readonly reason: string
}

// The action being rated: a tool invocation. `command` for bash; `path` for edit/write/read.
export interface Action {
  readonly tool: string
  readonly command?: string
  readonly path?: string
}

const READONLY_TOOLS = new Set(["read", "grep", "glob", "list", "lsp"])
const BOOKKEEPING_TOOLS = new Set(["task", "todowrite", "todoread", "skill", "question"])

// Paths whose contents are secrets/credentials — reading (exfiltration) or writing them is high-risk.
const SECRET_PATH =
  /(^|[/\\])\.env\b(?!\.example)|(^|[/\\])\.ssh[/\\]|(^|[/\\])\.aws[/\\]|(^|[/\\])\.gnupg[/\\]|id_rsa|id_ed25519|id_ecdsa|\.pem$|\.p12$|\.pfx$|(^|[/\\])\.npmrc$|(^|[/\\])\.git-credentials|(^|[/\\])\.netrc|credentials|secret|private[_-]?key/i

// System/OS locations that should not be modified casually.
const SYSTEM_PATH = /^([/\\]etc[/\\]|[/\\]usr[/\\]|[/\\]bin[/\\]|[/\\]boot[/\\]|[/\\]sys[/\\]|[/\\]dev[/\\]|[a-zA-Z]:[/\\]Windows[/\\])/i

interface Rule {
  readonly level: Level
  readonly re: RegExp
  readonly reason: string
}

// Ordered MOST-SEVERE FIRST; first match wins.
const BASH_RULES: Rule[] = [
  { level: "critical", re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },
  { level: "critical", re: /\bmkfs\b|\bdd\b[^|]*\bof=\/dev\/|>\s*\/dev\/(sd|nvme|disk|hd)/i, reason: "writes a raw disk/partition" },
  { level: "critical", re: /\brm\b[^|]*-[a-z]*[rf][a-z]*\s+(\/|~|\$HOME)(\s|\*|\/|$)/i, reason: "recursive delete of root/home" },
  { level: "critical", re: /\bDROP\s+(DATABASE|SCHEMA)\b/i, reason: "drops a database" },
  {
    level: "high",
    re: /\bDROP\s+TABLE\b|\bTRUNCATE\s+(TABLE\s+)?\w|\bDELETE\s+FROM\b(?![^;]*\bWHERE\b)/i,
    reason: "destructive SQL (drop / truncate / unscoped delete)",
  },
  { level: "high", re: /\brm\b[^|]*\s-[a-z]*[rf]/i, reason: "recursive or forced file deletion" },
  { level: "high", re: /\bgit\s+push\b[^|]*(--force|--mirror|\s-f\b)/i, reason: "force-push rewrites remote history" },
  { level: "high", re: /\bgit\s+reset\b[^|]*--hard/i, reason: "hard reset discards local changes" },
  {
    level: "high",
    re: /\bgit\s+clean\b[^|]*\s-[a-z]*f|\bgit\s+filter-branch\b|\bgit\s+reflog\s+expire\b/i,
    reason: "irreversible git worktree/history change",
  },
  {
    level: "high",
    re: /\b(curl|wget|iwr|invoke-webrequest)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python\d?|node|pwsh|powershell)\b/i,
    reason: "pipes a remote script straight into a shell",
  },
  { level: "high", re: /\bchmod\b[^|]*(-R[^|]*777|\s777)|\bchown\b[^|]*\s-R/i, reason: "broad permission/ownership change" },
  {
    level: "high",
    re: /\bkubectl\s+delete\b|\bterraform\s+(destroy|apply)\b|\bdocker\s+(system\s+prune|volume\s+rm)\b|\bhelm\s+(delete|uninstall)\b|\baws\s+\w+\s+delete/i,
    reason: "destroys or applies infrastructure",
  },
  {
    level: "high",
    re: /\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b|\bcargo\s+publish\b|\bgh\s+release\s+create\b|\bnpm\s+deprecate\b|\bgit\s+push\b[^|]*--tags/i,
    reason: "publishes/releases (public, hard to undo)",
  },
  { level: "high", re: /\bshutdown\b|\breboot\b|\bhalt\b|\bkillall\b|\bpkill\b|\bsudo\b/i, reason: "shuts down / kills processes / elevates privileges" },
  {
    level: "medium",
    re: /\b(npm|yarn|pnpm)\s+(install|add|i)\b|\bpip\d?\s+install\b|\bgem\s+install\b|\bcargo\s+add\b|\bapt(-get)?\s+install\b|\bbrew\s+install\b/i,
    reason: "installs third-party code",
  },
  { level: "medium", re: /\bgit\s+(commit|add|merge|rebase|checkout|switch|stash|tag|cherry-pick)\b/i, reason: "mutates the local git repo" },
  { level: "medium", re: /\b(curl|wget|iwr|nc|netcat|ssh|scp|rsync|ftp|telnet)\b/i, reason: "network access / data transfer" },
  { level: "medium", re: /\b(mv|cp)\b|\s>\s*\S|\btee\b|\bsed\b[^|]*\s-i/i, reason: "moves / overwrites / edits files in place" },
  { level: "low", re: /\b(mkdir|touch|cd|export|pushd|popd|ln|chmod|kill)\b/i, reason: "minor filesystem/shell change" },
  {
    level: "safe",
    re: /^[\s('"]*\b(ls|cat|pwd|echo|printf|grep|rg|find|head|tail|wc|which|whoami|id|date|env|printenv|type|file|stat|uname|hostname|tree|diff|sort|uniq|awk|cut|jq|git\s+(status|log|diff|show|branch|remote|blame)|node\s+-v|npm\s+(ls|list|view|run\s+typecheck|test|run\s+test)|bun\s+(run\s+typecheck|test|run\s+test)|tsc\b|python\d?\s+-m\s+pytest)\b/i,
    reason: "read-only inspection / test",
  },
]

// Rate a single action on the unified scale. Deterministic and side-effect free.
export function heuristicRate(action: Action): Verdict {
  const tool = action.tool
  if (tool === "read") {
    if (action.path && SECRET_PATH.test(action.path))
      return { level: "high", reason: "reads a secrets/credentials file (exfiltration risk)" }
    return { level: "safe", reason: "read-only file access" }
  }
  if (READONLY_TOOLS.has(tool)) return { level: "safe", reason: "read-only operation" }
  if (tool === "webfetch" || tool === "websearch") return { level: "medium", reason: "fetches external network content" }
  if (tool === "edit" || tool === "write" || tool === "patch" || tool === "apply_patch") {
    if (action.path && SECRET_PATH.test(action.path))
      return { level: "high", reason: "writes a secrets/credentials file" }
    if (action.path && SYSTEM_PATH.test(action.path)) return { level: "high", reason: "writes a system/OS location" }
    return { level: "medium", reason: "modifies a file" }
  }
  if (tool === "bash" && action.command) {
    for (const rule of BASH_RULES) if (rule.re.test(action.command)) return { level: rule.level, reason: rule.reason }
    return { level: "unknown", reason: "unrecognized shell command" }
  }
  if (BOOKKEEPING_TOOLS.has(tool)) return { level: "safe", reason: "orchestration / bookkeeping tool" }
  return { level: "unknown", reason: "unrecognized action" }
}

export * as RiskAnalyzer from "./risk"
