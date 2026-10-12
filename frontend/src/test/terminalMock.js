import { vi } from "vitest";

export class MockTerminal {
  static instances = [];
  constructor(options) {
    this.options = options;
    this.cols = 80;
    this.rows = 24;
    this.buffer = { active: { viewportY: 0, baseY: 0 } };
    this.subscriptions = [];
    MockTerminal.instances.push(this);
  }
  loadAddon = vi.fn();
  open = vi.fn((element) => {
    this.element = document.createElement("pre");
    this.element.setAttribute("data-testid", "terminal-screen");
    element.appendChild(this.element);
  });
  write = vi.fn((text, callback) => {
    this.element.textContent += text;
    callback?.();
  });
  reset = vi.fn(() => {
    this.element.textContent = "";
  });
  focus = vi.fn();
  scrollToBottom = vi.fn();
  dispose = vi.fn();
  subscribe(kind, callback) {
    this[kind] = callback;
    const subscription = { dispose: vi.fn() };
    this.subscriptions.push(subscription);
    return subscription;
  }
  onData = (callback) => this.subscribe("input", callback);
  onResize = (callback) => this.subscribe("resize", callback);
  onScroll = (callback) => this.subscribe("scroll", callback);
}
