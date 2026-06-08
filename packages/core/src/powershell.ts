export type PowerShellRiskLevel = "safe" | "ask" | "deny";

const commandSeparator = "(?:^|[\\s;&|])";
const commandEnd = "(?=$|[\\s;&|])";
const chainPattern = /[;&|]/;

const denyPatterns = [
  new RegExp(`${commandSeparator}(?:Remove-Item|rm|del|erase)${commandEnd}`, "i"),
  new RegExp(`${commandSeparator}Set-ExecutionPolicy${commandEnd}`, "i"),
  new RegExp(`${commandSeparator}Stop-Process${commandEnd}`, "i"),
  new RegExp(`${commandSeparator}Restart-Computer${commandEnd}`, "i"),
  /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b.*\|.*\b(?:iex|Invoke-Expression)\b/i,
  /\bgit\s+reset\b(?=.*(?:--hard|-hard)\b)/i,
  /\bgit\s+clean\b(?=.*-[a-z]*f[a-z]*)(?=.*-[a-z]*d[a-z]*)(?=.*-[a-z]*x[a-z]*)/i
];

const safePatterns = [
  new RegExp(`${commandSeparator}(?:Get-ChildItem|gci|ls|dir)${commandEnd}`, "i"),
  new RegExp(`${commandSeparator}(?:Get-Content|gc|cat|type)${commandEnd}`, "i"),
  new RegExp(`${commandSeparator}(?:Get-Location|pwd)${commandEnd}`, "i"),
  /\bgit\s+(?:status|diff|log|branch|show)\b/i
];

export function classifyPowerShellCommand(command: string): PowerShellRiskLevel {
  const stripped = command.trim();
  if (!stripped) {
    return "safe";
  }
  if (denyPatterns.some((pattern) => pattern.test(stripped))) {
    return "deny";
  }
  if (chainPattern.test(stripped)) {
    return "ask";
  }
  if (safePatterns.some((pattern) => pattern.test(stripped))) {
    return "safe";
  }
  return "ask";
}
