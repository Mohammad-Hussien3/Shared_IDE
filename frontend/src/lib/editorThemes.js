import { SPARK_THEMES } from "./sparkTheme";

export function createMonacoTheme(mode) {
  const p = SPARK_THEMES[mode];
  const hex = color => color.slice(1);
  return {
    base: mode === "light" ? "vs" : "vs-dark",
    inherit: true,
    // Inherit language-specific tokenization and use distinct, restrained colors.
    rules: [
      { token: "", foreground: hex(p.text) },
      { token: "comment", foreground: hex(p.comment) },
      { token: "keyword", foreground: hex(p.purple) },
      { token: "string", foreground: hex(p.success) },
      { token: "number", foreground: hex(p.accentSoft) },
      { token: "type", foreground: hex(p.cyan) },
      { token: "type.identifier", foreground: hex(p.cyan) },
      { token: "identifier", foreground: hex(p.text) },
      { token: "delimiter", foreground: hex(p.muted) },
      { token: "tag", foreground: hex(p.blue) },
      { token: "attribute.name", foreground: hex(p.accentSoft) },
      { token: "attribute.value", foreground: hex(p.success) },
      { token: "regexp", foreground: hex(p.warning) },
    ],
    colors: {
      "focusBorder": p.accent,
      "editor.background": p.bg,
      "editor.foreground": p.text,
      "editorLineNumber.foreground": p.faint,
      "editorLineNumber.activeForeground": p.accentSoft,
      "editor.lineHighlightBackground": p.surface,
      "editor.lineHighlightBorder": "#00000000",
      "editorCursor.foreground": p.accent,
      "editor.selectionBackground": p.selection,
      "editor.inactiveSelectionBackground": `${p.selection}88`,
      "editor.selectionHighlightBackground": `${p.selection}66`,
      "editor.selectionHighlightBorder": `${p.accent}55`,
      "editor.wordHighlightBackground": `${p.selection}66`,
      "editor.wordHighlightStrongBackground": `${p.selection}aa`,
      "editor.findMatchBackground": p.selected,
      "editor.findMatchBorder": p.accent,
      "editor.findMatchHighlightBackground": `${p.selection}88`,
      "editorIndentGuide.background1": p.borderSoft,
      "editorIndentGuide.activeBackground1": p.border,
      "editorWhitespace.foreground": `${p.faint}66`,
      "editorGutter.background": p.bg,
      "editorBracketMatch.background": p.selected,
      "editorBracketMatch.border": p.accent,
      "editorBracketHighlight.foreground1": p.accentSoft,
      "editorBracketHighlight.foreground2": p.purple,
      "editorBracketHighlight.foreground3": p.cyan,
      "editorBracketHighlight.foreground4": p.blue,
      "editorBracketHighlight.foreground5": p.success,
      "editorBracketHighlight.foreground6": p.warning,
      "editorBracketHighlight.unexpectedBracket.foreground": p.danger,
      "editorError.foreground": p.danger,
      "editorWarning.foreground": p.warning,
      "editorInfo.foreground": p.blue,
      "editorWidget.background": p.elevated,
      "editorWidget.foreground": p.text,
      "editorWidget.border": p.border,
      "editorWidget.resizeBorder": p.accent,
      "editorSuggestWidget.background": p.elevated,
      "editorSuggestWidget.foreground": p.text,
      "editorSuggestWidget.border": p.border,
      "editorSuggestWidget.selectedBackground": p.selected,
      "editorSuggestWidget.selectedForeground": p.strong,
      "editorSuggestWidget.highlightForeground": p.accentSoft,
      "editorSuggestWidget.focusHighlightForeground": p.accentSoft,
      "editorHoverWidget.background": p.elevated,
      "editorHoverWidget.foreground": p.text,
      "editorHoverWidget.border": p.border,
      "editorHoverWidget.statusBarBackground": p.surface,
      "input.background": p.bg,
      "input.foreground": p.text,
      "input.border": p.border,
      "inputOption.activeBorder": p.accent,
      "inputOption.activeBackground": p.selected,
      "list.hoverBackground": p.hover,
      "list.activeSelectionBackground": p.selected,
      "list.activeSelectionForeground": p.strong,
      "scrollbarSlider.background": `${p.muted}25`,
      "scrollbarSlider.hoverBackground": `${p.muted}40`,
      "scrollbarSlider.activeBackground": `${p.accent}55`,
      "scrollbar.shadow": "#00000000",
      "minimap.background": p.bg,
      "minimap.selectionHighlight": p.selection,
      "minimapSlider.background": `${p.muted}20`,
      "minimapSlider.hoverBackground": `${p.muted}35`,
      "minimapSlider.activeBackground": `${p.accent}40`,
      "widget.shadow": p.shadow,
    },
  };
}

export function defineEditorThemes(monaco) {
  for (const mode of ["dark", "light"]) {
    monaco.editor.defineTheme(`spark-${mode}`, createMonacoTheme(mode));
  }
}

function terminalTheme(mode) {
  const p = SPARK_THEMES[mode];
  return {
    background: p.bg, foreground: p.text, cursor: p.accent, cursorAccent: p.bg,
    selectionBackground: `${p.selection}bb`, selectionInactiveBackground: `${p.selection}77`,
    black: mode === "dark" ? "#453543" : "#30202d",
    red: p.danger, green: p.success, yellow: p.warning, blue: p.blue,
    magenta: p.purple, cyan: p.cyan, white: p.text,
    brightBlack: p.faint, brightRed: p.danger, brightGreen: p.success,
    brightYellow: p.accentSoft, brightBlue: p.blue, brightMagenta: p.purple,
    brightCyan: p.cyan, brightWhite: p.strong,
    scrollbarSliderBackground: `${p.muted}25`, scrollbarSliderHoverBackground: `${p.muted}40`,
    scrollbarSliderActiveBackground: `${p.accent}55`,
  };
}
export const TERMINAL_THEMES = { dark: terminalTheme("dark"), light: terminalTheme("light") };
