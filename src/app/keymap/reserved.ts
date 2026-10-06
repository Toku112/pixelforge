/**
 * Shortcuts the browser keeps for itself in a normal tab: pages never receive them
 * (CLAUDE.md §7). In fullscreen with the Keyboard Lock API, or in the installed app
 * window, most of them become available.
 */
import { canonicalChord, type Platform } from './chord';

const RESERVED: Record<Platform, readonly string[]> = {
  other: [
    'Mod+N',
    'Mod+Shift+N',
    'Mod+T',
    'Mod+Shift+T',
    'Mod+W',
    'Mod+Shift+W',
    'Mod+Tab',
    'Mod+Shift+Tab',
    'Ctrl+Tab',
    'Ctrl+Shift+Tab',
    'Alt+F4',
  ],
  mac: [
    'Mod+N',
    'Mod+Shift+N',
    'Mod+T',
    'Mod+Shift+T',
    'Mod+W',
    'Mod+Shift+W',
    'Mod+Q',
    'Mod+H',
    'Mod+Alt+H',
    'Mod+M',
    'Mod+Space',
    'Mod+Tab',
    'Ctrl+Tab',
    'Ctrl+Shift+Tab',
  ],
};

const canonical: Record<Platform, Set<string>> = {
  other: new Set(RESERVED.other.map(canonicalChord)),
  mac: new Set(RESERVED.mac.map(canonicalChord)),
};

/** True when the browser normally intercepts this chord before the page sees it. */
export function isBrowserReserved(chord: string, platform: Platform): boolean {
  return canonical[platform].has(canonicalChord(chord));
}

/**
 * Asks the browser to deliver reserved shortcuts to the page while in fullscreen
 * (Keyboard Lock API, Chromium). Returns false if unsupported.
 */
export async function lockKeyboardInFullscreen(): Promise<boolean> {
  const keyboard = (navigator as Navigator & { keyboard?: { lock(keys?: string[]): Promise<void> } }).keyboard;
  if (!keyboard?.lock || !document.fullscreenElement) return false;
  try {
    await keyboard.lock();
    return true;
  } catch {
    return false;
  }
}
