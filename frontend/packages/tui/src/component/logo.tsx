import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"

/**
 * Home-screen brand mark (mockup spec): a rounded icon tile with a red `>_`,
 * the lowercase letter-spaced wordmark in chrome, and the tagline underneath.
 */
export function Logo() {
  const { theme } = useTheme()

  return (
    <box alignItems="center" gap={1}>
      <box
        border
        borderStyle="rounded"
        borderColor={theme.primary}
        paddingLeft={2}
        paddingRight={2}
        alignItems="center"
      >
        <text fg={theme.primary} attributes={TextAttributes.BOLD} selectable={false}>
          {">_"}
        </text>
      </box>
      <box height={0} />
      <text fg={theme.text} attributes={TextAttributes.BOLD} selectable={false}>
        {"o r y n r"}
      </text>
      <text fg={theme.textMuted} selectable={false}>
        {"local-first coding agent"}
      </text>
    </box>
  )
}
