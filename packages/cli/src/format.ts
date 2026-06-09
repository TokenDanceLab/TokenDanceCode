export interface CliStyle {
  color: boolean;
}

type ColorToken = "accent" | "success" | "warning" | "danger" | "muted" | "section";

const ansiColorTokens: Record<ColorToken, string> = {
  accent: "36",
  success: "32",
  warning: "33",
  danger: "31",
  muted: "2",
  section: "1"
};

export function styleFromEnv(env: Record<string, string | undefined>): CliStyle {
  if (env.NO_COLOR !== undefined) {
    return { color: false };
  }
  return { color: env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0" };
}

export function heading(text: string, style: CliStyle = { color: false }): string {
  return colorize(text, "section", style);
}

export function label(text: string, style: CliStyle = { color: false }): string {
  return colorize(text, "accent", style);
}

export function ok(text: string, style: CliStyle = { color: false }): string {
  return colorize(text, "success", style);
}

export function warn(text: string, style: CliStyle = { color: false }): string {
  return colorize(text, "warning", style);
}

export function error(text: string, style: CliStyle = { color: false }): string {
  return colorize(text, "danger", style);
}

export function dim(text: string, style: CliStyle = { color: false }): string {
  return colorize(text, "muted", style);
}

export function badge(text: string, tone: "info" | "success" | "warning" | "danger", style: CliStyle = { color: false }): string {
  const badgeText = `[${text}]`;
  if (tone === "success") {
    return ok(badgeText, style);
  }
  if (tone === "warning") {
    return warn(badgeText, style);
  }
  if (tone === "danger") {
    return error(badgeText, style);
  }
  return label(badgeText, style);
}

function colorize(text: string, token: ColorToken, style: CliStyle): string {
  if (!style.color) {
    return text;
  }
  return `\u001B[${ansiColorTokens[token]}m${text}\u001B[0m`;
}
