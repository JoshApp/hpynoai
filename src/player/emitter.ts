/** Tiny typed event emitter. */
export class Emitter<E extends Record<string, unknown>> {
  private map = new Map<keyof E, Set<(payload: never) => void>>();

  on<K extends keyof E>(name: K, fn: (payload: E[K]) => void): () => void {
    let set = this.map.get(name);
    if (!set) { set = new Set(); this.map.set(name, set); }
    set.add(fn as (payload: never) => void);
    return () => { set?.delete(fn as (payload: never) => void); };
  }

  emit<K extends keyof E>(name: K, payload: E[K]): void {
    const set = this.map.get(name);
    if (!set) return;
    for (const fn of set) (fn as (p: E[K]) => void)(payload);
  }

  clear(): void { this.map.clear(); }
}
