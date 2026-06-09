export interface CliStyle {
  color: boolean;
}

export function styleFromEnv(env: Record<string, string | undefined>): CliStyle {
  if (env.NO_COLOR !== undefined) {
    return { color: false };
  }
  return { color: env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0" };
}

export function heading(text: string, style: CliStyle = { color: false }): string {
  return colorize(text, "bold", style);
}

export function label(text: string, style: CliStyle = { color: false }): string {
  return colorize(text, "cyan", style);
}

export function ok(text: string, style: CliStyle = { color: false }): string {
  return colorize(text, "green", style);
}

export function warn(text: string, style: CliStyle = { color: false }): string {
  return colorize(text, "yellow", style);
}

export function error(text: string, style: CliStyle = { color: false }): string {
  return colorize(text, "red", style);
}

export function dim(text: string, style: CliStyle = { color: false }): string {
  return colorize(text, "dim", style);
}

function colorize(text: string, tone: "bold" | "cyan" | "green" | "yellow" | "red" | "dim", style: CliStyle): string {
  if (!style.color) {
    return text;
  }
  const codes: Record<typeof tone, string> = {
    bold: "1",
    cyan: "36",
    green: "32",
    yellow: "33",
    red: "31",
    dim: "2"
  };
  return `\u001B[${codes[tone]}m${text}\u001B[0m`;
}
