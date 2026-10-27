/**
 * `fn` over every item with at most `limit` calls in flight, the results in the items' order whatever
 * order the calls finish in. With a limit of 1 it is a plain loop. Rejects with the first rejection.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`mapLimit: limit must be a whole number of at least 1, not ${limit}`);
  const out = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}
