// Shared by sign-out and other tabs. No private page snapshots are retained.
export const SIGNED_OUT_KEY = "lifeos:signed-out";

export async function clearPrivateBrowserState(): Promise<void> {
  if ("caches" in window) {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("life-os-") && key !== "life-os-public-v5").map((key) => caches.delete(key)));
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.controller?.postMessage({ type: "PURGE_PRIVATE_DATA" });
  }
}

export function announceSignOut(): void {
  try { localStorage.setItem(SIGNED_OUT_KEY, String(Date.now())); } catch { /* Auth's own event still clears this tab. */ }
}
