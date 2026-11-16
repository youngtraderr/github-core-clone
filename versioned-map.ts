// Track all writes, including REST and GraphQL ref updates, without scanning stored data.
export class VersionedMap<K, V> extends Map<K, V> {
  version = 0;
  set(key: K, value: V): this { super.set(key, value); this.version++; return this; }
  delete(key: K): boolean { const removed = super.delete(key); if (removed) this.version++; return removed; }
  clear(): void { if (this.size) { super.clear(); this.version++; } }
}
