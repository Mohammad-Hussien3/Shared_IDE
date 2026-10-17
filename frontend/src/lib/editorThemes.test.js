import { expect, it, vi } from "vitest";
import { createMonacoTheme, defineEditorThemes, TERMINAL_THEMES } from "./editorThemes";
import { installSparkTokens, SPARK_THEMES } from "./sparkTheme";

const luminance = hex => {
  const rgb = hex.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255)
    .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
};
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);

it("installs both palettes as CSS variables without changing the selected theme", () => {
  const root = document.createElement("div");
  root.dataset.theme = "light";
  installSparkTokens(root);
  for (const [mode, palette] of Object.entries(SPARK_THEMES)) {
    for (const [key, value] of Object.entries(palette)) {
      const name = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
      expect(root.style.getPropertyValue(`--spark-${mode}-${name}`)).toBe(value);
    }
  }
  expect(root.dataset.theme).toBe("light");
});

it.each(["dark", "light"])("shares %s surfaces and accents across CSS, Monaco, and xterm", mode => {
  const p = SPARK_THEMES[mode];
  const editor = createMonacoTheme(mode);
  expect(editor.inherit).toBe(true);
  expect(editor.base).toBe(mode === "dark" ? "vs-dark" : "vs");
  expect(editor.colors["editor.background"]).toBe(p.bg);
  expect(TERMINAL_THEMES[mode].background).toBe(p.bg);
  expect(TERMINAL_THEMES[mode].foreground).toBe(p.text);
  expect(editor.colors["editorCursor.foreground"]).toBe(TERMINAL_THEMES[mode].cursor);
  expect(editor.colors["editorSuggestWidget.background"]).toBe(p.elevated);
  expect(editor.colors["editorHoverWidget.border"]).toBe(p.border);
  expect(editor.colors["editorBracketMatch.border"]).toBe(p.accent);
  expect(editor.colors["minimap.background"]).toBe(p.bg);
  expect(new Set(editor.rules.map(rule => rule.foreground)).size).toBeGreaterThan(6);
  for (const key of ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]) {
    expect(TERMINAL_THEMES[mode][key]).toMatch(/^#[a-f\d]{6}$/i);
    expect(TERMINAL_THEMES[mode][`bright${key[0].toUpperCase()}${key.slice(1)}`]).toMatch(/^#[a-f\d]{6}$/i);
  }
});

it.each(["dark", "light"])("keeps %s code and interface text readable", mode => {
  const p = SPARK_THEMES[mode];
  for (const color of [p.text, p.strong, p.muted]) {
    for (const surface of [p.bg, p.surface, p.elevated]) {
      expect(contrast(color, surface)).toBeGreaterThanOrEqual(4.5);
    }
  }
  for (const rule of createMonacoTheme(mode).rules) {
    expect(contrast(`#${rule.foreground}`, p.bg)).toBeGreaterThanOrEqual(4.5);
  }
});

it("registers both named Monaco themes without changing models or languages", () => {
  const monaco = { editor: { defineTheme: vi.fn() } };
  defineEditorThemes(monaco);
  expect(monaco.editor.defineTheme).toHaveBeenCalledTimes(2);
  expect(monaco.editor.defineTheme).toHaveBeenCalledWith("spark-dark", createMonacoTheme("dark"));
  expect(monaco.editor.defineTheme).toHaveBeenCalledWith("spark-light", createMonacoTheme("light"));
});
