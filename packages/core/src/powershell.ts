export type PowerShellRiskLevel = "safe" | "ask" | "deny";

export interface PowerShellRiskClassification {
  level: PowerShellRiskLevel;
  reason: string;
  evidence?: PowerShellRiskEvidence;
}

export interface PowerShellRiskEvidence {
  rule: string;
  matched: string;
  commandPreview: string;
}

const commandSeparator = "(?:^|[\\s;&|])";
const commandEnd = "(?=$|[\\s;&|])";
const chainPattern = /[;&|]/;

const denyPatterns = [
  { label: "Remove-Item/rm/del/erase", pattern: new RegExp(`${commandSeparator}(?:Remove-Item|rm|del|erase)${commandEnd}`, "i"), evidencePattern: /\b(?:Remove-Item|rm|del|erase)\b/i },
  { label: "Set-ExecutionPolicy", pattern: new RegExp(`${commandSeparator}Set-ExecutionPolicy${commandEnd}`, "i"), evidencePattern: /\bSet-ExecutionPolicy\b/i },
  { label: "Stop-Process", pattern: new RegExp(`${commandSeparator}Stop-Process${commandEnd}`, "i"), evidencePattern: /\bStop-Process\b/i },
  { label: "Restart-Computer", pattern: new RegExp(`${commandSeparator}Restart-Computer${commandEnd}`, "i"), evidencePattern: /\bRestart-Computer\b/i },
  {
    label: "download pipe to Invoke-Expression",
    pattern: /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b.*\|.*\b(?:iex|Invoke-Expression)\b/i,
    evidencePattern: /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\r\n]*\|[^\r\n]*\b(?:iex|Invoke-Expression)\b/i
  },
  { label: "git reset --hard", pattern: /\bgit\s+reset\b(?=.*(?:--hard|-hard)\b)/i, evidencePattern: /\bgit\s+reset\b[^\r\n;&|]*(?:--hard|-hard)\b/i },
  { label: "git clean -fdx", pattern: /\bgit\s+clean\b(?=.*-[a-z]*f[a-z]*)(?=.*-[a-z]*d[a-z]*)(?=.*-[a-z]*x[a-z]*)/i, evidencePattern: /\bgit\s+clean\b[^\r\n;&|]*-[a-z]*f[a-z]*[^\r\n;&|]*/i }
];

const safePatterns = [
  { label: "read directory", pattern: new RegExp(`${commandSeparator}(?:Get-ChildItem|gci|ls|dir)${commandEnd}`, "i") },
  { label: "read file", pattern: new RegExp(`${commandSeparator}(?:Get-Content|gc|cat|type)${commandEnd}`, "i") },
  { label: "read location", pattern: new RegExp(`${commandSeparator}(?:Get-Location|pwd)${commandEnd}`, "i") },
  { label: "read-only git", pattern: /\bgit\s+(?:status|diff|log|branch|show)\b/i }
];

export function classifyPowerShellCommand(command: string): PowerShellRiskLevel {
  return classifyPowerShellCommandWithReason(command).level;
}

export function classifyPowerShellCommandWithReason(command: string): PowerShellRiskClassification {
  const stripped = command.trim();
  if (!stripped) {
    return { level: "safe", reason: "empty command" };
  }
  const denyMatch = denyPatterns.find(({ pattern }) => pattern.test(stripped));
  if (denyMatch) {
    const evidence = matchedEvidence(stripped, denyMatch.label, denyMatch.evidencePattern);
    return {
      level: "deny",
      reason: `command matches blocked pattern '${denyMatch.label}' with evidence '${evidence.matched}'`,
      evidence
    };
  }
  if (chainPattern.test(stripped)) {
    return { level: "ask", reason: "command chaining requires review" };
  }
  const safeMatch = safePatterns.find(({ pattern }) => pattern.test(stripped));
  if (safeMatch) {
    return { level: "safe", reason: `command matches read-only pattern '${safeMatch.label}'` };
  }
  return { level: "ask", reason: "command is not in the read-only allowlist" };
}

function matchedEvidence(command: string, rule: string, pattern: RegExp): PowerShellRiskEvidence {
  const match = pattern.exec(command);
  return {
    rule,
    matched: boundedEvidence(match?.[0] ?? command),
    commandPreview: boundedEvidence(command)
  };
}

function boundedEvidence(value: string): string {
  const evidence = value.trim().replace(/\s+/g, " ").replace(/'/g, "\"");
  return evidence.length > 120 ? `${evidence.slice(0, 117)}...` : evidence;
}
