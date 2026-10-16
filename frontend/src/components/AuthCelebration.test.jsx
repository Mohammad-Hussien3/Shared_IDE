import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import AuthCelebration from "./AuthCelebration";

it.each([undefined, "google-start", "failed"])("does not celebrate an unconfirmed result (%s)", kind => {
  render(<MemoryRouter initialEntries={[{ pathname: "/login", state: { authCelebration: kind } }]}><AuthCelebration /></MemoryRouter>);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("shows a brief non-blocking confirmation and clears its timer on unmount", () => {
  vi.useFakeTimers();
  const view = render(<MemoryRouter initialEntries={[{ pathname: "/check-email", state: { authCelebration: "registered" } }]}><AuthCelebration /></MemoryRouter>);
  expect(screen.getByRole("status")).toHaveTextContent("Check your inbox!");
  act(() => vi.advanceTimersByTime(1800));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
  const second = render(<MemoryRouter initialEntries={[{ pathname: "/workspaces", state: { authCelebration: "signed-in" } }]}><AuthCelebration /></MemoryRouter>);
  expect(vi.getTimerCount()).toBe(1);
  second.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
