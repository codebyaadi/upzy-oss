/**
 * Public status pages are cached for a short while so a busy page can't hammer the database. The admin API clears
 * the cache the moment a page changes, so unpublishing a page (or fixing a notice) takes effect at once.
 */
export const statusCache = new Map<string, { at: number; body: unknown }>();
export const forgetStatusPage = (...slugs: (string | undefined)[]) => {
  for (const s of slugs) if (s) statusCache.delete(s);
};

/** For changes that can touch any page (e.g. an incident update): the cache is small, so just empty it. */
export const forgetAllStatusPages = () => statusCache.clear();
