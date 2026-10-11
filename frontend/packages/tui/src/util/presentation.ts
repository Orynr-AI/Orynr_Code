const reset = "\x1b[0m"
const bold = "\x1b[1m"
const dim = "\x1b[90m"
const primary = "\x1b[38;5;203m" // brand accent (the red `>_` mark)

// The goodbye card printed to stdout after the TUI tears down on /exit. Matches the home-screen
// brand mark (component/logo.tsx): the red `>_` prompt + the letter-spaced "orynr" wordmark.
export function sessionEpilogue(input: { title: string; sessionID?: string }) {
  const weak = (text: string) => `${dim}${text.padEnd(10, " ")}${reset}`
  return [
    "",
    `  ${primary}${bold}>_${reset}  ${bold}o r y n r${reset}`,
    `  ${dim}local-first coding agent${reset}`,
    "",
    `  ${weak("Session")}${bold}${input.title}${reset}`,
    `  ${weak("Continue")}${bold}orynr -s ${input.sessionID}${reset}`,
    "",
  ].join("\n")
}
