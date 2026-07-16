import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

export type Theme = "lastlight" | "neaform";

interface ThemeContextValue {
  theme: Theme;
  /** Convenience — true for the dark `lastlight` theme. */
  isDark: boolean;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
}

const STORAGE_KEY = "ll-theme";

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Read the theme the inline `index.html` boot script already applied to
 * `<html>` — the single source of truth, so there's no flash and no need to
 * re-derive from localStorage / prefers-color-scheme here. */
function currentTheme(): Theme {
  const attr = document.documentElement.getAttribute("data-theme");
  return attr === "neaform" ? "neaform" : "lastlight";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(currentTheme);

  const setTheme = useCallback((t: Theme) => {
    document.documentElement.setAttribute("data-theme", t);
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      // Private-mode / storage-disabled — theme still applies for this session.
    }
    setThemeState(t);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "lastlight" ? "neaform" : "lastlight");
  }, [theme, setTheme]);

  return (
    <ThemeContext.Provider
      value={{ theme, isDark: theme === "lastlight", setTheme, toggleTheme }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
