/**
 * A bounded in-process cache with per-entry expiry.
 *
 * ## Why this replaced Redis
 *
 * Redis was holding three caches — Indian Kanoon results, eCourts lookups and
 * embeddings — and on a single VPS none of them needs to be shared between
 * processes. What they need is to be *bounded*, so a long-running container
 * cannot grow until it is killed, and that is what a plain Map does not give
 * you.
 *
 * ## The one thing to know before scaling out
 *
 * This is per-process. Two processes keep two copies, and neither can invalidate
 * the other's. That is correct for a cache of immutable things — a reported
 * judgment does not change once published — and would be wrong for anything
 * mutable. Nothing mutable belongs in here.
 *
 * ## Why the eviction is LRU and not just "oldest inserted"
 *
 * Both are one line. LRU is the one that keeps the entry an advocate has hit
 * four times today and drops the one nobody asked for again, which for a cache
 * of search results is most of the value. `Map` preserves insertion order and
 * re-inserting moves a key to the end, so a read that deletes and re-sets is a
 * complete LRU implementation with no bookkeeping.
 */

interface Entry<V> {
  value: V;
  /** Epoch milliseconds. Compared on read; nothing sweeps in the background. */
  expiresAt: number;
}

export class LruCache<V> {
  private readonly entries = new Map<string, Entry<V>>();

  constructor(
    private readonly maxEntries: number,
    private readonly defaultTtlSeconds: number,
  ) {}

  /**
   * Read a live entry, or undefined.
   *
   * Expiry is checked here rather than swept on a timer. A background sweep
   * would keep a container awake and would still have to check on read anyway,
   * because an entry can expire between sweeps.
   */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }

    // Re-insert to move this key to the end of the iteration order, which is
    // what makes the first key the least recently *used* rather than the
    // least recently written.
    this.entries.delete(key);
    this.entries.set(key, entry);

    return entry.value;
  }

  set(key: string, value: V, ttlSeconds = this.defaultTtlSeconds): void {
    // Delete first so an overwrite also moves the key to the end.
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });

    // One eviction per insert is enough to hold the bound, because the bound
    // can only ever be exceeded by one.
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Live entry count. Expired-but-unread entries are still counted. */
  get size(): number {
    return this.entries.size;
  }
}
