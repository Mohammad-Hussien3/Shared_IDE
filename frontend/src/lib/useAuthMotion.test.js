import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import useAuthMotion from "./useAuthMotion";

let media, original;
beforeEach(() => {
  original = window.matchMedia;
  media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  window.matchMedia = vi.fn(() => media);
});
afterEach(() => { window.matchMedia = original; });

it("batches pointer updates in one frame, clamps gaze, ignores touch, and cleans up", () => {
  let callback;
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(fn => { callback = fn; return 42; });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  const { result, unmount } = renderHook(() => useAuthMotion());
  const event = { pointerType: "mouse", clientX: 100, clientY: 0, currentTarget: { getBoundingClientRect: () => ({ width: 100, height: 100, left: 0, top: 0 }) } };
  act(() => {
    result.current.trackPointer(event);
    result.current.trackPointer({ ...event, clientX: 400 });
  });
  expect(raf).toHaveBeenCalledTimes(1);
  act(() => callback());
  expect(result.current.gaze).toEqual({ x: 1, y: -1 });
  act(() => result.current.trackPointer({ ...event, pointerType: "touch" }));
  expect(raf).toHaveBeenCalledTimes(1);
  act(() => result.current.trackInput({ target: { selectionStart: 12, value: "not retained" } }));
  act(() => callback());
  expect(result.current.gaze).toEqual({ x: 0, y: .3 });
  act(() => result.current.resetGaze());
  unmount();
  expect(cancel).toHaveBeenCalledWith(42);
  expect(media.removeEventListener).toHaveBeenCalledWith("change", media.addEventListener.mock.calls[0][1]);
});

it("disables tracking and resets gaze when reduced motion is enabled, then resumes safely", () => {
  let callback;
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(fn => { callback = fn; return 7; });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  const { result } = renderHook(() => useAuthMotion());
  act(() => result.current.trackInput({ target: { selectionStart: 24 } }));
  act(() => callback());
  expect(result.current.gaze.x).toBe(1);
  act(() => {
    media.matches = true;
    media.addEventListener.mock.calls[0][1]();
  });
  expect(result.current.reducedMotion).toBe(true);
  expect(result.current.gaze).toEqual({ x: 0, y: 0 });
  act(() => result.current.trackInput({ target: { selectionStart: 24 } }));
  expect(raf).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalled();
  act(() => {
    media.matches = false;
    media.addEventListener.mock.calls[0][1]();
  });
  act(() => result.current.resetGaze());
  expect(raf).toHaveBeenCalledTimes(2);
});
