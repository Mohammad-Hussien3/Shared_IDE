import { useState } from "react";

export function useTheme() {
  const [theme, setTheme] = useState(
    () => localStorage.getItem("ide-theme") || "dark",
  );
  const toggle = () =>
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      localStorage.setItem("ide-theme", next);
      document.documentElement.dataset.theme = next;
      return next;
    });
  return [theme, toggle];
}
