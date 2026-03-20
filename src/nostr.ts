import { SimplePool, type NostrEvent, type Filter } from 'nostr-tools';
import { getPool } from './bunker';

const EOSE_TIMEOUT_MS = 10_000;

function fetchEvents(relayUrl: string, filter: Filter): Promise<NostrEvent[]> {
  return new Promise((resolve, reject) => {
    const pool: SimplePool = getPool();
    const events: NostrEvent[] = [];
    const timer = setTimeout(() => {
      sub.close();
      resolve(events);
    }, EOSE_TIMEOUT_MS);

    const sub = pool.subscribeMany([relayUrl], filter, {
      onevent(event: NostrEvent) {
        events.push(event);
      },
      oneose() {
        clearTimeout(timer);
        sub.close();
        resolve(events);
      },
    });
  });
}

/**
 * Fetch all metadata (dataset index) events for a given pubkey.
 * These are kind-123 events tagged with ['l', 'metadata'].
 */
export async function fetchMetadataEvents(relayUrl: string, pubkey: string): Promise<NostrEvent[]> {
  return fetchEvents(relayUrl, {
    kinds: [123],
    authors: [pubkey],
    '#l': ['metadata'],
  });
}

/**
 * Fetch all data bucket events for a specific dataset hash.
 * These are kind-123 events tagged with ['d', datasetHash].
 */
export async function fetchDatasetEvents(
  relayUrl: string,
  pubkey: string,
  datasetHash: string,
): Promise<NostrEvent[]> {
  return fetchEvents(relayUrl, {
    kinds: [123],
    authors: [pubkey],
    '#d': [datasetHash],
  });
}
