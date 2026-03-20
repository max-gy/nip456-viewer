# NIP-456 Viewer

A read-only browser-based viewer for NIP-456 health data stored on Nostr relays. Decryption is handled entirely by a remote signer via [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md) (Nostr Connect) — no private keys ever touch this app.

## How it works

1. **Connect** — the app generates an ephemeral keypair and produces a `nostrconnect://` URI. Scan the QR code (or copy the URI) in a NIP-46 compatible signer app (e.g. [nsecBunker](https://nsecbunker.com), Amber).
2. **Browse** — once the signer approves, enter the data relay URL and load your NIP-456 metadata events. The app fetches kind-123 events tagged `['l', 'metadata']` for your pubkey.
3. **Inspect** — click a dataset card to fetch and decrypt its data bucket events (`['d', <hash>]`) and view the decrypted time-series data in a table.

Session state (the ephemeral keypair + signer connection details) is persisted in `localStorage` so approving the signer once survives page reloads. Use the **Disconnect** button to clear the session.

## Stack

| | |
|---|---|
| Bundler | [Vite](https://vitejs.dev) |
| Language | TypeScript |
| Nostr | [nostr-tools](https://github.com/nbd-wtf/nostr-tools) 2.x |
| QR codes | [qrcode](https://github.com/soldair/node-qrcode) |

## Getting started

```bash
npm install
npm run dev
```

Open http://localhost:5173 in your browser.

## Build

```bash
npm run build   # output goes to dist/
npm run preview # preview the production build locally
```

## Security notes

- The ephemeral client private key stored in `localStorage` is **not** the user's Nostr identity key. It only authenticates this app session to the remote signer.
- All NIP-456 data decryption happens in the remote signer; the app only ever sees plaintext after the signer has authorised the request.
- XSS is the primary threat to the stored session key. Serve this app over HTTPS and from a trusted origin.
