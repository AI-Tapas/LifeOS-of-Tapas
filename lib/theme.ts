// The theme setting: System, Light or Dark. Kept on the device rather than in
// the database on purpose. It is a property of the screen you are looking at,
// not of the account: the phone in bed at night and the laptop at the desk
// reasonably differ, and a device preference should not need a round trip.

export type ThemeChoice = "system" | "light" | "dark";

export const THEME_KEY = "life_os_theme";

export function isThemeChoice(v: unknown): v is ThemeChoice {
  return v === "system" || v === "light" || v === "dark";
}

// Runs in the document head before first paint, so the page never flashes the
// wrong theme. Inlined as a string because it must execute before React, and
// deliberately tiny and defensive: a browser with site data blocked throws on
// localStorage, and the page must still render.
export const THEME_BOOT_SCRIPT = `
(function () {
  try {
    var root = document.documentElement;
    var pick = function () {
      var choice = null;
      try { choice = localStorage.getItem(${JSON.stringify(THEME_KEY)}); } catch (e) {}
      if (choice !== "light" && choice !== "dark") {
        choice = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
      root.setAttribute("data-theme", choice);
    };
    pick();
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    var onChange = function () {
      var stored = null;
      try { stored = localStorage.getItem(${JSON.stringify(THEME_KEY)}); } catch (e) {}
      if (stored !== "light" && stored !== "dark") pick();
    };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  } catch (e) {}
})();
`;

// Client-side counterpart: apply a choice immediately when Settings changes it.
export function applyTheme(choice: ThemeChoice): void {
  const resolved =
    choice === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : choice;
  document.documentElement.setAttribute("data-theme", resolved);
}

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return isThemeChoice(v) ? v : "system";
  } catch {
    return "system";
  }
}

// The setting lives in localStorage, which React cannot see as state. This is
// the store shape useSyncExternalStore wants: subscribe, a client snapshot and
// a server snapshot. Reading it in an effect instead would both trip
// react-hooks/set-state-in-effect and paint the wrong option for a frame.
const listeners = new Set<() => void>();

export function subscribeTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Snapshots must be referentially stable: ThemeChoice is a string, so the
// value itself is the identity and React can compare it safely.
export function themeSnapshot(): ThemeChoice {
  return readTheme();
}

// The server has no device and no storage, so it renders the neutral option.
export function themeServerSnapshot(): ThemeChoice {
  return "system";
}

export function writeTheme(choice: ThemeChoice): void {
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Site data blocked: the choice applies for this page view only.
  }
  applyTheme(choice);
  for (const fn of listeners) fn();
}
