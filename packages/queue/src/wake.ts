import type { Db } from "@upzy/db";

/** Postgres channel the `jobs` insert trigger notifies on (migration 0039). The payload is the queue name. */
export const WAKE_CHANNEL = "upzy_jobs";

/** Wakes a waiting worker loop when a job for its queue is inserted, instead of making it poll. */
export class Waker {
  private waiters = new Map<string, Set<() => void>>();
  /** Queues notified while no loop was waiting, so the next wait returns at once and the job isn't missed. */
  private pending = new Set<string>();

  notify(queue: string) {
    const w = this.waiters.get(queue);
    if (w && w.size > 0) {
      for (const wake of [...w]) wake();
    } else this.pending.add(queue);
  }

  /** Resolves when `queue` is notified, after `fallbackMs`, or when `signal` aborts, whichever comes first. */
  wait(queue: string, fallbackMs: number, signal?: AbortSignal): Promise<void> {
    if (this.pending.delete(queue) || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const set = this.waiters.get(queue) ?? new Set<() => void>();
      this.waiters.set(queue, set);
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, fallbackMs);
      set.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}

interface Shared {
  waker: Waker;
  users: number;
  stop: () => Promise<void>;
}

const sharedByDb = new WeakMap<object, Promise<Shared | null>>();

interface Listening {
  listen(channel: string, onNotify: (payload: string) => void): Promise<unknown>;
}

/**
 * One listening connection per database handle, shared by every worker loop in the process. Returns null when LISTEN
 * is not available (a connection pooler in transaction mode, a restricted role): callers then poll as before.
 */
export async function acquireWaker(
  db: Db,
): Promise<{ waker: Waker; release: () => Promise<void> } | null> {
  let pending = sharedByDb.get(db);
  if (!pending) {
    pending = (async () => {
      const client = (db as unknown as { $client?: Partial<Listening> }).$client;
      if (!client || typeof client.listen !== "function") return null;
      const waker = new Waker();
      try {
        const handle = (await client.listen(WAKE_CHANNEL, (queue: string) =>
          waker.notify(queue),
        )) as { unlisten?: () => Promise<void> } | undefined;
        return {
          waker,
          users: 0,
          stop: async () => {
            await handle?.unlisten?.();
          },
        };
      } catch (e) {
        console.warn("[queue] LISTEN is not available; polling instead:", (e as Error).message);
        return null;
      }
    })();
    sharedByDb.set(db, pending);
  }
  const shared = await pending;
  if (!shared) return null;
  shared.users++;
  return {
    waker: shared.waker,
    release: async () => {
      if (--shared.users > 0) return;
      sharedByDb.delete(db);
      await shared.stop().catch(() => {});
    },
  };
}
