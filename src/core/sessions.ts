import fs from "node:fs/promises";
import path from "node:path";
import type { SessionsFile, UserRecord } from "./types";

export class SessionsStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "sessions.json");
  }

  async ensureDir(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
  }

  async loadAll(): Promise<SessionsFile> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as SessionsFile;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private async saveAll(data: SessionsFile): Promise<void> {
    await this.ensureDir();
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await fs.rename(tmp, this.filePath);
  }

  async get(userId: string): Promise<UserRecord | undefined> {
    const all = await this.loadAll();
    return all[userId];
  }

  async setRepo(userId: string, repoUrl: string): Promise<void> {
    const all = await this.loadAll();
    const prev = all[userId];
    all[userId] = {
      repoUrl,
      agentId: prev?.agentId,
      sessionStartedAt: prev?.sessionStartedAt,
    };
    await this.saveAll(all);
  }

  async setAgent(userId: string, agentId: string, repoUrl: string): Promise<void> {
    const all = await this.loadAll();
    all[userId] = {
      repoUrl,
      agentId,
      sessionStartedAt: new Date().toISOString(),
    };
    await this.saveAll(all);
  }

  async clearAgent(userId: string): Promise<void> {
    const all = await this.loadAll();
    const prev = all[userId];
    if (!prev) return;
    all[userId] = { repoUrl: prev.repoUrl };
    await this.saveAll(all);
  }
}
