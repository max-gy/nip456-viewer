import {
  BunkerSigner,
  BunkerSignerParams,
  createNostrConnectURI,
  NostrConnectParams,
} from 'nostr-tools/nip46';
import { generateSecretKey, getPublicKey, SimplePool } from 'nostr-tools';
import { getConversationKey, decrypt } from 'nostr-tools/nip44';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

const PERMISSIONS = ['get_public_key', 'nip44_decrypt'];
const APP_NAME = 'NIP-456-Viewer';
const APP_URL = 'https://soundhsa.com';
const TIMEOUT_MS = 120_000;

export const DEFAULT_SIGNER_RELAYS = [
  'wss://nos.lol',
  'wss://nostr.bitcoiner.social',
  'wss://relay.primal.net',
];

const SESSION_STORAGE_KEY = 'nip456_bunker_session';

interface StoredSession {
  localPrivKeyHex: string;
  bunkerPubkey: string;
  signerRelays: string[];
  secret: string;
  connectedPubKey: string;
}

let bunker: BunkerSigner | null = null;
let bunkerConnectionPromise: Promise<BunkerSigner> | null = null;
let pool: SimplePool | null = null;
let localPrivKey: Uint8Array | null = null;
let connectedPubKey: string | null = null;
let storedSignerRelays: string[] | null = null;
let storedSecret: string | null = null;
let storedBunkerPubkey: string | null = null;

export function isConnected(): boolean {
  return bunker !== null && connectedPubKey !== null;
}

export function getPool(): SimplePool {
  if (!pool) pool = new SimplePool();
  return pool;
}

/**
 * Tears down the current pool and bunker, then creates fresh instances
 * from the stored session state. This forces new WebSocket connections
 * to the relay, working around stale/cached connections in SimplePool.
 */
function reconnectBunker(): void {
  if (!localPrivKey || !storedBunkerPubkey || !storedSignerRelays?.length) {
    throw new Error('Cannot reconnect — missing session state');
  }

  // Close the old bunker subscription if still around
  try { bunker?.close(); } catch { /* already closed */ }

  // Destroy the old pool so SimplePool doesn't reuse a dead websocket
  try { pool?.destroy(); } catch { /* ignore */ }
  pool = null;

  const signerParams: BunkerSignerParams = {
    pool: getPool(),
    onauth: (authUrl: string) => {
      window.open(authUrl, '_blank');
    },
  };

  bunker = BunkerSigner.fromBunker(localPrivKey, {
    pubkey: storedBunkerPubkey,
    relays: storedSignerRelays,
    secret: storedSecret || '',
  }, signerParams);

  console.debug('Bunker reconnected with fresh pool/subscription');
}

/**
 * Generates an ephemeral keypair, builds a nostrconnect:// URI and starts
 * listening for the remote signer approval.
 *
 * Returns the URI string — render it as a QR code and/or copy link.
 * Call awaitConnection() after to wait until the signer approves.
 */
export async function initBunker(signerRelays: string[]): Promise<string> {
  // Reset any previous state
  bunker = null;
  bunkerConnectionPromise = null;
  connectedPubKey = null;
  storedSignerRelays = null;
  storedSecret = null;
  storedBunkerPubkey = null;

  const sk = generateSecretKey();
  localPrivKey = sk;
  const localPubKey = getPublicKey(sk);
  const secret = bytesToHex(generateSecretKey()).slice(0, 16);
  storedSignerRelays = signerRelays;
  storedSecret = secret;

  const params: NostrConnectParams = {
    clientPubkey: localPubKey,
    relays: signerRelays,
    secret,
    perms: PERMISSIONS,
    name: encodeURIComponent(APP_NAME),
    url: encodeURIComponent(APP_URL),
  };

  const uri = await createNostrConnectURI(params);

  // Start listening for approval but don't block — return URI immediately
  // so the caller can display the QR code before the user scans it.
  //
  // We intentionally avoid BunkerSigner.fromURI here because it calls
  // switchRelays() internally (nostr-tools 2.x bug) which races against
  // the 1-second timeout, then continues running in the background,
  // eventually closing the post-approval subscription and breaking
  // subsequent requests like getPublicKey.
  //
  // Instead we listen for the approval event ourselves and construct the
  // signer via BunkerSigner.fromBunker which never calls switchRelays.
  const clientPubKey = getPublicKey(localPrivKey);
  const signerParams: BunkerSignerParams = {
    pool: getPool(),
    onauth: (authUrl: string) => {
      window.open(authUrl, '_blank');
    },
  };

  bunkerConnectionPromise = new Promise<BunkerSigner>((resolve, reject) => {
    let approved = false;

    const timeout = setTimeout(() => {
      sub.close();
      reject(new Error('Remote signer approval timed out'));
    }, TIMEOUT_MS);

    const sub = getPool().subscribe(
      signerRelays,
      { kinds: [24133], '#p': [clientPubKey], limit: 0 },
      {
        onevent: (event) => {
          if (approved) return;
          try {
            const convKey = getConversationKey(localPrivKey!, event.pubkey);
            const payload = JSON.parse(decrypt(event.content, convKey));
            if (payload.result !== secret) return;

            approved = true;
            clearTimeout(timeout);
            storedBunkerPubkey = event.pubkey;

            const signer = BunkerSigner.fromBunker(localPrivKey!, {
              pubkey: event.pubkey,
              relays: signerRelays,
              secret,
            }, signerParams);

            // Resolve BEFORE closing the approval sub so fromBunker's
            // setupSubscription is active first — this keeps the relay
            // WebSocket alive and prevents the pool from disconnecting
            // between sub.close() and the new subscription being established.
            resolve(signer);
            sub.close();
          } catch {
            // not our event or bad encryption — keep waiting
          }
        },
        onclose: () => {
          if (!approved) reject(new Error('Relay subscription closed before approval'));
        },
      },
    );
  });

  return uri;
}

/**
 * Waits for the remote signer to approve the connection.
 * Call this after displaying the QR code returned by initBunker().
 */
export async function awaitBunkerConnection(): Promise<void> {
  if (!bunkerConnectionPromise) throw new Error('Bunker not initialised — call initBunker first');
  bunker = await bunkerConnectionPromise;
  connectedPubKey = await bunker.getPublicKey();
  saveSession();
}

function saveSession(): void {
  if (!localPrivKey || !connectedPubKey || !storedBunkerPubkey || !storedSignerRelays?.length || !storedSecret) return;
  const session: StoredSession = {
    localPrivKeyHex: bytesToHex(localPrivKey),
    bunkerPubkey: storedBunkerPubkey,
    signerRelays: storedSignerRelays,
    secret: storedSecret,
    connectedPubKey,
  };
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_STORAGE_KEY);
  bunker = null;
  localPrivKey = null;
  connectedPubKey = null;
  storedSignerRelays = null;
  storedSecret = null;
  storedBunkerPubkey = null;
}

/**
 * Attempts to restore a previously saved bunker session from localStorage.
 * Creates a fresh pool + subscription so we don't reuse stale websockets
 * from a previous page load.
 * Returns the connected pubkey on success, or null if no valid session exists.
 */
export function restoreSession(): string | null {
  const raw = localStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) return null;

  let session: StoredSession;
  try {
    session = JSON.parse(raw) as StoredSession;
    if (!session.localPrivKeyHex || !session.bunkerPubkey || !session.signerRelays?.length || !session.connectedPubKey) {
      clearSession();
      return null;
    }
  } catch {
    clearSession();
    return null;
  }

  try {
    localPrivKey = hexToBytes(session.localPrivKeyHex);
    storedBunkerPubkey = session.bunkerPubkey;
    storedSignerRelays = session.signerRelays;
    storedSecret = session.secret;
    connectedPubKey = session.connectedPubKey;

    // Force a fresh pool + subscription so we don't reuse a stale websocket
    // left over from the previous page load.
    reconnectBunker();

    return connectedPubKey;
  } catch {
    clearSession();
    return null;
  }
}

export async function getConnectedPubKey(): Promise<string> {
  if (!bunker) throw new Error('Bunker not connected');
  if (connectedPubKey) return connectedPubKey;
  connectedPubKey = await bunker.getPublicKey();
  return connectedPubKey;
}

/**
 * Decrypt a NIP-44 ciphertext that was encrypted by/to `senderPubKey`.
 * For NIP-456 self-encrypted data, senderPubKey === the user's own pubkey.
 */
export async function decryptWithBunker(senderPubKey: string, ciphertext: string): Promise<string> {
  if (!bunker) throw new Error('Bunker not connected');
  return bunker.nip44Decrypt(senderPubKey, ciphertext);
}
