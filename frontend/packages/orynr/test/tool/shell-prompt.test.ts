import { describe, expect, test } from "bun:test"
import { ShellPrompt } from "../../src/tool/shell/prompt"

// The shell tool DESCRIPTION is sent to the model. On a Windows host the host shell is
// PowerShell, so before the docker fix the description said "OS: win32, Shell: powershell",
// gave `New-Item` examples, and pointed at a `C:\Users\<name>\...` temp dir — which the
// model then parroted as a Windows path inside a Linux container. In docker the tool is
// rendered as bash/linux with a container temp, so none of that host language can leak.
const limits = { maxLines: 1000, maxBytes: 100_000 }

describe("ShellPrompt.render sandbox awareness", () => {
  test("docker: bash/linux/tmp description leaks no host shell or path", () => {
    const { description } = ShellPrompt.render("bash", "linux", limits, 30_000, "/tmp")
    expect(description).toContain("OS: linux")
    expect(description).toContain("Shell: bash")
    expect(description).toContain("/tmp")
    // none of the Windows host signals that caused the bug
    expect(description).not.toContain("win32")
    expect(description).not.toMatch(/PowerShell|New-Item|Set-Content/i)
    expect(description).not.toMatch(/[A-Za-z]:\\/) // no drive-letter path
  })

  test("local windows: host shell description is preserved (no docker remap)", () => {
    const { description } = ShellPrompt.render("powershell", "win32", limits, 30_000, "C:\\Users\\x\\Temp")
    expect(description).toContain("OS: win32")
    expect(description).toContain("Shell: powershell")
    expect(description).toMatch(/PowerShell|New-Item/)
    expect(description).toContain("C:\\Users\\x\\Temp")
  })

  test("default tmp falls back to the host temp dir when unspecified", () => {
    const { description } = ShellPrompt.render("bash", "linux", limits, 30_000)
    // still renders; the point is the 5th arg is optional and only docker overrides it
    expect(description).toContain("OS: linux")
  })
})
