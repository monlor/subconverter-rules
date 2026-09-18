import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** In-memory KV with optional JSON file persistence (survives process restarts). */
interface Entry {
  value: string;
  expiresAt: number | null;
}

export class MemoryKV {
  private store = new Map<string, Entry>();
  private persistFile: string | null;

  constructor(cacheDir?: string) {
    this.persistFile = cacheDir ? join(cacheDir, 'kv.json') : null;
    this.load();
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    const expiresAt = opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : null;
    this.store.set(key, { value, expiresAt });
    this.flush();
  }

  async list(opts?: { prefix?: string }): Promise<{ keys: { name: string }[] }> {
    const prefix = opts?.prefix ?? '';
    const keys = [...this.store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name }));
    return { keys };
  }

  private load(): void {
    if (!this.persistFile || !existsSync(this.persistFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistFile, 'utf8')) as Record<string, Entry>;
      const now = Date.now();
      for (const [k, v] of Object.entries(raw)) {
        if (!v || typeof v.value !== 'string') continue;
        if (v.expiresAt !== null && v.expiresAt < now) continue;
        this.store.set(k, v);
      }
    } catch (err) {
      console.warn('subhub: failed to load cache file, starting empty:', err);
    }
  }

  private flush(): void {
    if (!this.persistFile) return;
    try {
      mkdirSync(dirname(this.persistFile), { recursive: true });
      const now = Date.now();
      const obj: Record<string, Entry> = {};
      for (const [k, v] of this.store) {
        if (v.expiresAt !== null && v.expiresAt < now) continue;
        obj[k] = v;
      }
      const tmp = this.persistFile + '.tmp';
      writeFileSync(tmp, JSON.stringify(obj));
      renameSync(tmp, this.persistFile);
    } catch (err) {
      console.warn('subhub: failed to persist cache:', err);
    }
  }
}
