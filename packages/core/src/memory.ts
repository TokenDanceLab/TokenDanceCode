import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface MemoryStoreOptions {
  projectRoot: string;
  homeDir?: string;
}

export class MemoryStore {
  constructor(private readonly options: MemoryStoreOptions) {}

  async addProjectMemory(text: string): Promise<void> {
    await this.append(this.projectMemoryPath(), text);
  }

  async listProjectMemory(): Promise<string[]> {
    return this.readEntries(this.projectMemoryPath());
  }

  async deleteProjectMemory(index: number): Promise<void> {
    await this.delete(this.projectMemoryPath(), index);
  }

  async addGlobalMemory(text: string): Promise<void> {
    await this.append(this.globalMemoryPath(), text);
  }

  async listGlobalMemory(): Promise<string[]> {
    return this.readEntries(this.globalMemoryPath());
  }

  async deleteGlobalMemory(index: number): Promise<void> {
    await this.delete(this.globalMemoryPath(), index);
  }

  projectMemoryPath(): string {
    return join(this.options.projectRoot, ".tokendance", "memory", "project.md");
  }

  globalMemoryPath(): string {
    return join(this.options.homeDir ?? process.env.USERPROFILE ?? process.env.HOME ?? this.options.projectRoot, ".tokendance", "memory", "global.md");
  }

  private async append(path: string, text: string): Promise<void> {
    const entries = await this.readEntries(path);
    entries.push(text);
    await this.writeEntries(path, entries);
  }

  private async delete(path: string, index: number): Promise<void> {
    const entries = await this.readEntries(path);
    if (index >= 0 && index < entries.length) {
      entries.splice(index, 1);
    }
    await this.writeEntries(path, entries);
  }

  private async readEntries(path: string): Promise<string[]> {
    try {
      const content = await readFile(path, "utf8");
      return content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2));
    } catch {
      return [];
    }
  }

  private async writeEntries(path: string, entries: string[]): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, entries.map((entry) => `- ${entry}\n`).join(""), "utf8");
  }
}
