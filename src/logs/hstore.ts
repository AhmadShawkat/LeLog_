export type HstorePair = readonly [key: string, value: string];

function quoteHstoreValue(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function serializeHstorePairs(pairs: Iterable<HstorePair>): string {
  return [...pairs]
    .map(
      ([key, value]) => `${quoteHstoreValue(key)}=>${quoteHstoreValue(value)}`,
    )
    .join(',');
}

export function serializeHstoreRecord(
  record: Readonly<Record<string, string>>,
): string {
  return serializeHstorePairs(Object.entries(record));
}
