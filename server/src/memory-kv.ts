/** Minimal in-memory replacement for Cloudflare KVNamespace (subset actually used). */
interface Entry {
  value: string;
  expiresAt: number | null;
}

export class MemoryKV {
  private store = new Map<string, Entry>();

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
  }

  async list(opts?: { prefix?: string }): Promise<{ keys: { name: string }[] }> {
    const prefix = opts?.prefix ?? '';
    const keys = [...this.store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name }));
    return { keys };
  }
}
