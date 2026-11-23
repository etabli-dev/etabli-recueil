/**
 * Capacitor 8 configuration (ADR-0024). The app serves `www/`, assembled by `scripts/assemble.mjs`
 * from the web client's build and the shell's pages; the server it talks to is the user's own,
 * configured on first launch and kept in the platform's secure store.
 */
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.etabli.recueil',
  appName: 'Recueil',
  webDir: 'www',
  // No live-reload server and no cleartext: the shell's own files are local, and the Recueil
  // server is reached over HTTPS (or loopback during development).
  android: {
    allowMixedContent: false,
  },
  ios: {
    contentInset: 'automatic',
  },
};

export default config;
