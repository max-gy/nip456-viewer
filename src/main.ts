import QRCode from 'qrcode';
import { Chart, BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend } from 'chart.js';
import { type NostrEvent } from 'nostr-tools';
import { initBunker, awaitBunkerConnection, getConnectedPubKey, decryptWithBunker, isConnected, clearSession, restoreSession, DEFAULT_SIGNER_RELAYS } from './bunker';
import { fetchMetadataEvents, fetchDatasetEvents } from './nostr';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend);

// ── Types ──────────────────────────────────────────────────────────────────

interface Nip456EventContent {
  startDate: number;
  endDate: number;
  interval: string;
  dataType: string;
  datasetName: string;
  source: string;
  applicationSource: string;
  data: number[][];
  info?: string;
}

interface DatasetSummary {
  datasetName: string;
  datasetHash: string;
  createdAt: Date;
  dataType: string;
}

// ── DOM refs ───────────────────────────────────────────────────────────────

const signerRelaysInput  = document.getElementById('signer-relays')  as HTMLTextAreaElement;
const btnConnect        = document.getElementById('btn-connect')     as HTMLButtonElement;
const connectResult     = document.getElementById('connect-result')!;
const qrContainer       = document.getElementById('qr-container')!;
const connectUriEl      = document.getElementById('connect-uri')!;
const btnCopyUri        = document.getElementById('btn-copy-uri')    as HTMLButtonElement;
const connectStatus     = document.getElementById('connect-status')!;

const sectionBrowse     = document.getElementById('section-browse')!;
const connectedPubkeyEl = document.getElementById('connected-pubkey')!;
const dataRelayInput    = document.getElementById('data-relay')      as HTMLInputElement;
const btnLoad           = document.getElementById('btn-load')        as HTMLButtonElement;
const loadStatus        = document.getElementById('load-status')!;
const datasetList       = document.getElementById('dataset-list')!;

const btnDisconnect     = document.getElementById('btn-disconnect')  as HTMLButtonElement;

const sectionDetail     = document.getElementById('section-detail')!;
const btnBack           = document.getElementById('btn-back')        as HTMLButtonElement;
const detailTitle       = document.getElementById('detail-title')!;
const detailStatus      = document.getElementById('detail-status')!;
const detailContent     = document.getElementById('detail-content')!;

// ── Helpers ────────────────────────────────────────────────────────────────

function setStatus(el: HTMLElement, msg: string, type: 'waiting' | 'success' | 'error' | 'loading') {
  el.textContent = msg;
  el.className = `status ${type}`;
  el.classList.remove('hidden');
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

// ── Session restore on startup ───────────────────────────────────────────

(function tryRestoreSession() {
  const pubkey = restoreSession();
  if (!pubkey) return;
  connectedPubkeyEl.textContent = pubkey;
  sectionBrowse.classList.remove('hidden');
  setStatus(connectStatus, '✓ Session restored from previous visit.', 'success');
  connectResult.classList.remove('hidden');
})();

// ── Step 1: Connect remote signer ─────────────────────────────────────────

btnConnect.addEventListener('click', async () => {
  const signerRelays = signerRelaysInput.value
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  if (signerRelays.length === 0) {
    setStatus(connectStatus, 'Please enter at least one signer relay URL.', 'error');
    connectResult.classList.remove('hidden');
    return;
  }

  btnConnect.disabled = true;
  btnConnect.textContent = 'Connecting…';
  connectResult.classList.remove('hidden');
  setStatus(connectStatus, 'Generating connect URI…', 'loading');

  try {
    const uri = await initBunker(signerRelays);

    // Render QR code immediately so the user can scan it
    qrContainer.innerHTML = '';
    const canvas = document.createElement('canvas');
    qrContainer.appendChild(canvas);
    await QRCode.toCanvas(canvas, uri, { width: 240, margin: 1 });

    // Show copyable URI
    connectUriEl.textContent = uri;

    setStatus(connectStatus, 'Scan the QR code or copy the URI, then approve in your signer…', 'waiting');
    btnConnect.disabled = false;
    btnConnect.textContent = 'Reconnect';

    // Now wait for the remote signer to approve
    await awaitBunkerConnection();

    setStatus(connectStatus, '✓ Signer connected!', 'success');

    // Reveal browse section
    const pubkey = await getConnectedPubKey();
    connectedPubkeyEl.textContent = pubkey;
    sectionBrowse.classList.remove('hidden');
    sectionBrowse.scrollIntoView({ behavior: 'smooth' });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    setStatus(connectStatus, `Error: ${msg}`, 'error');
    btnConnect.textContent = 'Generate Connect URI';
    btnConnect.disabled = false;
  }
});

btnDisconnect.addEventListener('click', () => {
  clearSession();
  location.reload();
});

btnCopyUri.addEventListener('click', () => {
  const uri = connectUriEl.textContent ?? '';
  if (!uri) return;
  navigator.clipboard.writeText(uri).then(() => {
    btnCopyUri.textContent = 'Copied!';
    setTimeout(() => { btnCopyUri.textContent = 'Copy'; }, 2000);
  });
});

// ── Step 2: Load datasets ─────────────────────────────────────────────────

btnLoad.addEventListener('click', async () => {
  if (!isConnected()) {
    setStatus(loadStatus, 'Not connected to a remote signer yet.', 'error');
    return;
  }

  const relayUrl = dataRelayInput.value.trim();
  if (!relayUrl) {
    setStatus(loadStatus, 'Please enter a data relay URL.', 'error');
    return;
  }

  btnLoad.disabled = true;
  btnLoad.textContent = 'Loading…';
  datasetList.innerHTML = '';
  setStatus(loadStatus, 'Fetching metadata events from relay…', 'loading');

  try {
    const pubkey = await getConnectedPubKey();
    const events = await fetchMetadataEvents(relayUrl, pubkey);

    if (events.length === 0) {
      setStatus(loadStatus, 'No NIP-456 datasets found on this relay for your pubkey.', 'waiting');
      btnLoad.disabled = false;
      btnLoad.textContent = 'Load Datasets';
      return;
    }
    const statusMsg = `Found ${events.length} metadata event(s).`;
    setStatus(loadStatus, statusMsg, 'loading');

    const seen = new Map<string, DatasetSummary>();

    let decryptedCount = 0;

    for (const event of events) {
      try {
        const decrypted = await decryptWithBunker(pubkey, event.content);
        decryptedCount++;
        setStatus(loadStatus, statusMsg + ` ${decryptedCount} decrypted.`, 'loading');
        const content: Nip456EventContent = JSON.parse(decrypted);
        const dTag = event.tags.find(t => t[0] === 'd');
        if (!dTag) continue;

        const datasetHash = dTag[1];
        const createdAt = new Date(event.created_at * 1000);

        // Keep only the most-recent metadata event per dataset name
        const existing = seen.get(content.datasetName);
        if (!existing || existing.createdAt < createdAt) {
          seen.set(content.datasetName, {
            datasetName: content.datasetName,
            datasetHash,
            createdAt,
            dataType: content.dataType,
          });
        }
      } catch {
        // Skip events that fail to decrypt
      }
    }

    setStatus(loadStatus, statusMsg + ` ${seen.size} dataset(s) decrypted.`, 'loading');

    if (seen.size === 0) {
      setStatus(loadStatus, 'Could not decrypt any metadata events. Make sure you are using the correct signer.', 'error');
      btnLoad.disabled = false;
      btnLoad.textContent = 'Load Datasets';
      return;
    }

    setStatus(loadStatus, `Found ${seen.size} dataset(s).`, 'success');
    renderDatasetCards([...seen.values()], relayUrl);

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    setStatus(loadStatus, `Error: ${msg}`, 'error');
  } finally {
    btnLoad.disabled = false;
    btnLoad.textContent = 'Load Datasets';
  }
});

function renderDatasetCards(datasets: DatasetSummary[], relayUrl: string) {
  datasetList.innerHTML = '';
  for (const ds of datasets) {
    const card = document.createElement('div');
    card.className = 'dataset-card';
    card.innerHTML = `
      <div class="ds-name">${escapeHtml(ds.datasetName)}</div>
      <div class="ds-meta">
        <span>Type: ${escapeHtml(ds.dataType)}</span>
        <span>Created: ${formatDate(ds.createdAt.getTime())}</span>
        <span style="font-family:var(--font-mono);font-size:0.7rem;color:var(--text-muted)">${escapeHtml(ds.datasetHash.slice(0, 12))}…</span>
      </div>
    `;
    card.addEventListener('click', () => openDataset(ds, relayUrl));
    datasetList.appendChild(card);
  }
}

// ── Step 3: Dataset detail ────────────────────────────────────────────────

async function openDataset(ds: DatasetSummary, relayUrl: string) {
  sectionDetail.classList.remove('hidden');
  detailTitle.textContent = ds.datasetName;
  detailContent.innerHTML = '';
  setStatus(detailStatus, 'Fetching data events…', 'loading');
  sectionDetail.scrollIntoView({ behavior: 'smooth' });

  try {
    const pubkey = await getConnectedPubKey();
    const events: NostrEvent[] = await fetchDatasetEvents(relayUrl, pubkey, ds.datasetHash);

    if (events.length === 0) {
      setStatus(detailStatus, 'No data events found for this dataset.', 'waiting');
      return;
    }

    let encryptedCount = 0;
    setStatus(detailStatus, `Decrypting ${events.length} event(s)…`, 'loading');

    interface Row { startDate: number; endDate: number; interval: string; dataType: string; source: string; applicationSource: string; data: number[][]; info?: string; }
    const rows: Row[] = [];

    for (const event of events) {
      try {
        const decrypted = await decryptWithBunker(pubkey, event.content);
        encryptedCount++;
        setStatus(detailStatus, `Decrypting ${events.length} event(s)… ${encryptedCount} decrypted.`, 'loading');
        const content: Nip456EventContent = JSON.parse(decrypted);
        rows.push(content);
      } catch {
        // Skip undecryptable events
      }
    }

    if (rows.length === 0) {
      setStatus(detailStatus, 'Could not decrypt any data events.', 'error');
      return;
    }

    rows.sort((a, b) => a.startDate - b.startDate);

    const first = rows[0];
    if (first) {
      detailTitle.innerHTML = `${escapeHtml(ds.datasetName)}<div class="detail-meta">Source: ${escapeHtml(first.source)} &middot; App: ${escapeHtml(first.applicationSource)}</div>`;
    }

    detailStatus.classList.add('hidden');
    renderDetailChart(rows);

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    setStatus(detailStatus, `Error: ${msg}`, 'error');
  }
}

let activeChart: Chart | null = null;

function renderDetailChart(rows: { startDate: number; endDate: number; interval: string; dataType: string; source: string; applicationSource: string; data: number[][]; info?: string }[]) {
  // Take the last 30 rows; each bar = sum of all values for that date
  const last30 = rows.slice(-30);

  const labels = last30.map(r => formatDate(r.startDate));
  const values = last30.map(r => r.data.flat().reduce((sum, v) => sum + v, 0));

  const dataType = last30[0]?.dataType ?? 'Value';

  const canvas = document.createElement('canvas');
  detailContent.appendChild(canvas);

  if (activeChart) {
    activeChart.destroy();
    activeChart = null;
  }

  activeChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: dataType,
        data: values,
        backgroundColor: 'rgba(99, 132, 255, 0.6)',
        borderColor: 'rgba(99, 132, 255, 1)',
        borderWidth: 1,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: true, position: 'top' },
        tooltip: { mode: 'index', intersect: false },
      },
      scales: {
        x: { title: { display: true, text: 'Date' } },
        y: { title: { display: true, text: dataType }, beginAtZero: true },
      },
    },
  });
}

// ── Back button ───────────────────────────────────────────────────────────

btnBack.addEventListener('click', () => {
  sectionDetail.classList.add('hidden');
  sectionBrowse.scrollIntoView({ behavior: 'smooth' });
});

// ── Utility ───────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
