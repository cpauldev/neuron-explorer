// Based on https://ui.shadcn.com/docs/dark-mode/vite.
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type Theme = "dark" | "light" | "system";
const STORAGE_KEY = "neuron-explorer-theme";
const isTheme = (value: unknown): value is Theme =>
  value === "dark" || value === "light" || value === "system";
const ThemeContext = createContext<{
  theme: Theme;
  setTheme: (theme: Theme) => void;
}>({
  theme: "light",
  setTheme: () => {},
});

export function ThemeProvider({
  children,
  defaultTheme = "light",
}: {
  children: ReactNode;
  defaultTheme?: Theme;
}) {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return isTheme(saved) ? saved : defaultTheme;
    } catch {
      return defaultTheme;
    }
  });

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.classList.remove("light", "dark");
      document.documentElement.classList.add(resolved);
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute(
          "content",
          getComputedStyle(document.documentElement)
            .getPropertyValue("--background")
            .trim(),
        );
    };
    apply();
    if (theme === "system") media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (
        event.storageArea === localStorage &&
        (event.key === STORAGE_KEY || event.key === null)
      ) {
        setThemeState(isTheme(event.newValue) ? event.newValue : defaultTheme);
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [defaultTheme]);

  const setTheme = (value: Theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      /* Still apply for this session. */
    }
    setThemeState(value);
  };
  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
