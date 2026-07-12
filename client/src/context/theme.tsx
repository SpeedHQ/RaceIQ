import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

export type Theme = "morph";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const THEME_KEY = "forza-theme";

const ThemeContext = createContext<ThemeContextValue>({
  theme: "morph",
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("morph");

  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, []);

  return <ThemeContext.Provider value={{ theme, setTheme: setThemeState }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
