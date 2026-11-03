/** General web search is too broad for the dedicated patent-search page. */
export function patentWebQuery(input: string): { query: string; scoped: boolean } {
  const query = input.trim();
  if (!query || /\bsite\s*:/i.test(query)) return { query, scoped: false };
  return { query: query + ' site:patents.google.com/patent', scoped: true };
}

export function patentPageLeads<T extends { url: string }>(items: T[], scoped: boolean): T[] {
  if (!scoped) return items;
  return items.filter(item => {
    try {
      const url = new URL(item.url);
      return url.protocol === 'https:' && url.hostname === 'patents.google.com' && /^\/patent\/[A-Z]{2}[A-Z0-9]+(?:\/|$)/i.test(url.pathname);
    } catch { return false; }
  });
}
