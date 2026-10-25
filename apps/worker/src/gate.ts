/**
 * Lets at most `limit` callers run at once; the rest wait their turn. The prober holds hundreds of checks open at a
 * time (they are network waits), but only a few may be using database connections, so claiming and finishing jobs
 * always find a free connection.
 */
export interface Gate {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createGate(limit: number): Gate {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("A gate needs a limit of at least 1");
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
      active++;
      try {
        return await fn();
      } finally {
        active--;
        waiting.shift()?.();
      }
    },
  };
}

/** No limit: for callers (tests, one-off runs) that don't share a pool. */
export const openGate: Gate = { run: (fn) => fn() };
