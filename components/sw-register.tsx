"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { announceSignOut, clearPrivateBrowserState, SIGNED_OUT_KEY } from "@/lib/auth/browser-session";

export default function SwRegister() {
  useEffect(() => {
    const loadedAt = Date.now();
    let leaving = false;
    async function leavePrivatePage() {
      if (leaving) return;
      leaving = true;
      try { await clearPrivateBrowserState(); } catch {
        // Public-only worker never reads private entries, even if CacheStorage
        // is unavailable. Always discard this tab's in-memory app state.
      }
      if (location.pathname !== "/login") location.replace("/login");
    }
    function onStorage(event: StorageEvent) {
      if (event.key === SIGNED_OUT_KEY && event.newValue) void leavePrivatePage();
    }
    function onPageShow(event: PageTransitionEvent) {
      try {
        if (event.persisted && Number(localStorage.getItem(SIGNED_OUT_KEY)) >= loadedAt) void leavePrivatePage();
      } catch { /* Storage can be unavailable; Auth still checks the session. */ }
    }
    window.addEventListener("storage", onStorage);
    window.addEventListener("pageshow", onPageShow);
    const { data: { subscription } } = createClient().auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        announceSignOut();
        // Do not await Supabase APIs inside its synchronous auth callback.
        void leavePrivatePage();
      }
    });
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then((registration) => registration.update()).catch(() => {
        // Registration failure is non-fatal; the app still works online.
      });
    }
    return () => {
      subscription.unsubscribe();
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  return null;
}
