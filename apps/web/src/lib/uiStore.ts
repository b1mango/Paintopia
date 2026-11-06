import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export type ThemePreference = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

type UiState = {
  theme: ThemePreference;
  language: "zh" | "en";
  reduceMotion: boolean;
  setTheme: (theme: ThemePreference) => void;
  setLanguage: (language: UiState["language"]) => void;
  setReduceMotion: (value: boolean) => void;
};

const colorSchemeQuery = "(prefers-color-scheme: dark)";
const getSystemTheme = (): ResolvedTheme =>
  typeof window !== "undefined" && window.matchMedia?.(colorSchemeQuery).matches ? "dark" : "light";
const getServerTheme = (): ResolvedTheme => "dark";

function subscribeSystemTheme(listener: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
  const media = window.matchMedia(colorSchemeQuery);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

// Storage can be unavailable in embedded/private contexts; keep in-memory preferences usable.
const storage: StateStorage = {
  getItem: (name) => { try { return localStorage.getItem(name); } catch { return null; } },
  setItem: (name, value) => { try { localStorage.setItem(name, value); } catch { /* unavailable */ } },
  removeItem: (name) => { try { localStorage.removeItem(name); } catch { /* unavailable */ } }
};

export const useUiStore = create<UiState>()(persist((set) => ({
  theme: "dark",
  language: "zh",
  reduceMotion: false,
  setTheme: (theme) => set({ theme }),
  setLanguage: (language) => set({ language }),
  setReduceMotion: (reduceMotion) => set({ reduceMotion })
}), {
  name: "paintopia-ui",
  storage: createJSONStorage(() => storage),
  partialize: ({ theme, language, reduceMotion }) => ({ theme, language, reduceMotion }),
  merge: (saved, current) => {
    const preferences = (saved && typeof saved === "object" ? saved : {}) as Partial<UiState>;
    return {
      ...current,
      theme: ["light", "dark", "system"].includes(preferences.theme ?? "") ? preferences.theme! : current.theme,
      language: preferences.language === "en" || preferences.language === "zh" ? preferences.language : current.language,
      reduceMotion: typeof preferences.reduceMotion === "boolean" ? preferences.reduceMotion : current.reduceMotion
    };
  }
}));

/** Resolve attributes/toggles while retaining the original preference for settings. */
export function useResolvedTheme(preference?: ThemePreference): ResolvedTheme {
  const theme = useUiStore((state) => state.theme);
  const systemTheme = useSyncExternalStore(subscribeSystemTheme, getSystemTheme, getServerTheme);
  const selected = preference ?? theme;
  return selected === "system" ? systemTheme : selected;
}

function syncDocumentPreferences() {
  if (typeof document === "undefined") return;
  const { theme, reduceMotion } = useUiStore.getState();
  const resolved = theme === "system" ? getSystemTheme() : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.reduceMotion = String(reduceMotion);
  // 手机浏览器地址栏跟随纸色
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "light" ? "#f2ede3" : "#131210");
}

syncDocumentPreferences();
const unsubscribeStore = useUiStore.subscribe(syncDocumentPreferences);
const unsubscribeSystem = subscribeSystemTheme(syncDocumentPreferences);
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeStore();
    unsubscribeSystem();
  });
}
