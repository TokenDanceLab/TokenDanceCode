import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TranscriptEnvelope } from "./types.js";

export interface CompactResult {
  path: string;
  summary: string;
  eventCount: number;
  range: string;
}

export class CompactService {
  constructor(private readonly sessionDir: string) {}

  async manualCompact(): Promise<CompactResult> {
    const envelopes = await readTranscript(join(this.sessionDir, "transcript.jsonl"));
    const compactDir = join(this.sessionDir, "compact");
    await mkdir(compactDir, { recursive: true });
    const path = join(compactDir, `compact-${String((await nextCompactIndex(compactDir))).padStart(4, "0")}.md`);
    const range =
      envelopes.length > 0
        ? `seq ${envelopes[0]?.seq ?? 1}-${envelopes.at(-1)?.seq ?? envelopes.length}`
        : "seq none";
    const summary = ["# Compact Summary", "", `Range: ${range}`, `Events: ${envelopes.length}`].join("\n");
    await writeFile(path, `${summary}\n`, "utf8");
    return { path, summary, eventCount: envelopes.length, range };
  }
}

async function nextCompactIndex(compactDir: string): Promise<number> {
  const entries = await readdir(compactDir);
  const indexes = entries
    .map((entry) => /^compact-(\d+)\.md$/.exec(entry)?.[1])
    .filter((value): value is string => value !== undefined)
    .map((value) => Number.parseInt(value, 10))
    .filter(Number.isFinite);
  return indexes.length > 0 ? Math.max(...indexes) + 1 : 1;
}

export async function readTranscript(path: string): Promise<TranscriptEnvelope[]> {
  try {
    const content = await readFile(path, "utf8");
    return content
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as TranscriptEnvelope);
  } catch {
    return [];
  }
}
