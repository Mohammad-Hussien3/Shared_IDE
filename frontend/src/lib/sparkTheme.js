// One palette for CSS, Monaco, and xterm. Install the CSS variables once at startup.
export const SPARK_THEMES = {
  dark: {
    bg: "#100d13", surface: "#1d1721", elevated: "#29212d", sidebar: "#19141d",
    inset: "#100d13", hover: "#302432", selected: "#3c2930", border: "#533341",
    borderSoft: "#322532", text: "#e4d3dc", strong: "#fff2ed", muted: "#bfaab7", faint: "#9b8192",
    accent: "#ff9a36", accentSoft: "#ffb16a", coral: "#ff445e", accentSolid: "#ff9a36",
    accentHover: "#ffb16a", accentText: "#26111b", success: "#a6d6b4", danger: "#ff9bab",
    warning: "#e9c083", shadow: "#00000066", selection: "#64414b",
    blue: "#91b9ef", purple: "#c7a5e9", cyan: "#8fd3ce", comment: "#a58f9e",
  },
  light: {
    bg: "#fffaf6", surface: "#f6eee9", elevated: "#ffffff", sidebar: "#f9f1ec",
    inset: "#fffaf6", hover: "#f0e1d9", selected: "#f8e0d0", border: "#d8bbb9",
    borderSoft: "#ead9d3", text: "#503c49", strong: "#30202d", muted: "#735c68", faint: "#806773",
    accent: "#9f4311", accentSoft: "#a14a19", coral: "#c72f4e", accentSolid: "#ff9a36",
    accentHover: "#ffb16a", accentText: "#26111b", success: "#286b43", danger: "#b72e4b",
    warning: "#83540d", shadow: "#503c4922", selection: "#f2cbb5",
    blue: "#245c9c", purple: "#79459d", cyan: "#1e6d71", comment: "#79616e",
  },
};

export function installSparkTokens(root = document.documentElement) {
  for (const [theme, palette] of Object.entries(SPARK_THEMES)) {
    for (const [name, value] of Object.entries(palette)) {
      const property = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
      root.style.setProperty(`--spark-${theme}-${property}`, value);
    }
  }
}
