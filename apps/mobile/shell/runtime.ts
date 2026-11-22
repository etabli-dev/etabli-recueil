/**
 * The shell's link to the phone: settings over the platform stores, and the capture capabilities
 * the web client's host contract offers (`apps/web/src/host.ts`, `HostCapabilities`).
 *
 * - Document scan: ML Kit's scanner on Android; on iOS, VisionKit through the app's own
 *   `RecueilScanner` plugin (`ios/App/App/RecueilScannerPlugin.swift`), because the ML Kit plugin
 *   does not implement iOS.
 * - ISBN barcodes: ML Kit barcode scanning on both.
 * - Share sheet: files shared into the app arrive through the share-target plugin.
 * - Network: the capture queue flushes when the connection returns.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { Network } from '@capacitor/network';
import { Preferences } from '@capacitor/preferences';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
import { DocumentScanner } from '@capacitor-mlkit/document-scanner';
import { CapacitorShareTarget } from '@capgo/capacitor-share-target';

import { memorySettings, pluginSettings } from './settings.js';
import type { SettingsBackend } from './settings.js';

export interface HostFile {
  readonly blob: Blob;
  readonly filename: string;
  readonly note?: string;
}

export interface Capabilities {
  scanDocument?(): Promise<HostFile[]>;
  scanBarcode?(): Promise<string | null>;
  onShared?(listener: (files: HostFile[]) => void): () => void;
  onNetworkChange?(listener: (online: boolean) => void): () => void;
  readonly platform?: string;
}

interface RecueilScannerPlugin {
  /** VisionKit's document camera; the pages as one PDF, base64-encoded. Rejects when cancelled. */
  scan(): Promise<{ pdf: string; pageCount: number }>;
}

const RecueilScanner = registerPlugin<RecueilScannerPlugin>('RecueilScanner');

export const defaultSettings = (): SettingsBackend => (Capacitor.isNativePlatform() ? pluginSettings(Preferences, SecureStorage) : memorySettings());

const stamp = (): string => new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19);

/** A file the native side wrote, read back as bytes through the web view's file bridge. */
const readNativeFile = async (uri: string, type?: string): Promise<Blob> => {
  const response = await fetch(Capacitor.convertFileSrc(uri));
  if (!response.ok) throw new Error(`Could not read ${uri} (${response.status}).`);
  const blob = await response.blob();
  // The share plugin copies files to `*.tmp`, so the bridge cannot tell the type; the sender can.
  return type === undefined || type === '' ? blob : new Blob([blob], { type });
};

const base64ToBlob = (base64: string, type: string): Blob => {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return new Blob([bytes], { type });
};

const cancelled = (error: unknown): boolean => /cancel/iu.test(error instanceof Error ? error.message : String(error));

/** Release a listener registered asynchronously, even if the page is torn down first. */
const releasing = (pending: Promise<PluginListenerHandle>): (() => void) => {
  let released = false;
  void pending.then((handle) => {
    if (released) void handle.remove();
  });
  return () => {
    released = true;
    void pending.then((handle) => handle.remove());
  };
};

/**
 * Shares are listened for from the moment the host script runs, not only while the Capture screen
 * is open, and kept until a listener takes them: a share that arrives while the app shows another
 * screen, or before React has mounted, is not lost.
 */
const createShareInbox = () => {
  const pending: HostFile[][] = [];
  const listeners = new Set<(files: HostFile[]) => void>();
  let started = false;
  const deliver = (files: HostFile[]): void => {
    if (listeners.size === 0) pending.push(files);
    else for (const listener of listeners) listener(files);
  };
  const start = (): void => {
    if (started) return;
    started = true;
    void CapacitorShareTarget.addListener('shareReceived', (event) => {
      void Promise.all(
        event.files.map(async (file) => ({ blob: await readNativeFile(file.uri, file.mimeType), filename: file.name || `shared-${stamp()}`, ...(event.title === '' ? {} : { note: event.title }) })),
      ).then(deliver, (error: unknown) => console.error('recueil: a shared file could not be read', error));
    });
  };
  return {
    start,
    subscribe: (listener: (files: HostFile[]) => void): (() => void) => {
      start();
      listeners.add(listener);
      for (const files of pending.splice(0)) listener(files);
      return () => listeners.delete(listener);
    },
  };
};

const shares = createShareInbox();

export const nativeCapabilities = (): Capabilities => {
  const platform = Capacitor.getPlatform();
  if (platform === 'web') return { platform };
  shares.start();
  return {
    platform,
    scanDocument: async () => {
      try {
        if (platform === 'ios') {
          const { pdf } = await RecueilScanner.scan();
          return [{ blob: base64ToBlob(pdf, 'application/pdf'), filename: `scan-${stamp()}.pdf` }];
        }
        const result = await DocumentScanner.scanDocument({ resultFormats: 'PDF', galleryImportAllowed: true, scannerMode: 'FULL', pageLimit: 30 });
        if (result.pdf === undefined) return [];
        return [{ blob: await readNativeFile(result.pdf.uri, 'application/pdf'), filename: `scan-${stamp()}.pdf` }];
      } catch (error) {
        if (cancelled(error)) return [];
        throw error;
      }
    },
    scanBarcode: async () => {
      if (platform === 'android') {
        const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
        if (!available) {
          // Installing only starts a download from Google Play; scanning before it finishes fails.
          await BarcodeScanner.installGoogleBarcodeScannerModule();
          throw new Error('Google’s barcode scanner is being installed on this phone. Try again in a minute.');
        }
      } else {
        await BarcodeScanner.requestPermissions();
      }
      try {
        const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.Ean13, BarcodeFormat.Ean8, BarcodeFormat.QrCode] });
        return barcodes[0]?.rawValue ?? null;
      } catch (error) {
        if (cancelled(error)) return null;
        throw error;
      }
    },
    onShared: (listener) => shares.subscribe(listener),
    onNetworkChange: (listener) => releasing(Network.addListener('networkStatusChange', (status) => listener(status.connected))),
  };
};
