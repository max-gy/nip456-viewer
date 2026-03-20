import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    include: ['nostr-tools', 'qrcode'],
  },
});
