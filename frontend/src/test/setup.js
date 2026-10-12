import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

class TestResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
vi.stubGlobal("ResizeObserver", TestResizeObserver);
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute("open", "");
};
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute("open");
};
HTMLElement.prototype.setPointerCapture = vi.fn();

vi.mock("@xterm/xterm", async () => ({
  Terminal: (await import("./terminalMock.js")).MockTerminal,
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dataset.theme = "dark";
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("Unexpected unmocked HTTP request"))),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
