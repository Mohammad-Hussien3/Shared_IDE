import { useCallback, useEffect, useRef, useState } from "react";

export default function useAuthMotion() {
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  const [gaze, setGaze] = useState({ x: 0, y: 0 });
  const frame = useRef(null);
  const next = useRef(gaze);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const change = () => {
      setReducedMotion(query.matches);
      if (query.matches) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
        setGaze({ x: 0, y: 0 });
      }
    };
    query?.addEventListener("change", change);
    return () => {
      query?.removeEventListener("change", change);
      cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, []);
  const look = useCallback((x, y) => {
    if (reducedMotion) return;
    next.current = { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setGaze(next.current);
    });
  }, [reducedMotion]);
  const trackPointer = event => {
    if (reducedMotion || event.pointerType === "touch") return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width && bounds.height) look(
      ((event.clientX - bounds.left) / bounds.width - .5) * 2,
      ((event.clientY - bounds.top) / bounds.height - .5) * 2,
    );
  };
  const trackInput = event => {
    // Only the caret position affects the expression; no input text is retained.
    const input = event.target;
    const position = input.selectionStart ?? input.value.length;
    look(Math.min(position / 24, 1) * 2 - 1, .3);
  };
  return { reducedMotion, gaze, trackPointer, trackInput, resetGaze: () => look(0, 0) };
}
