import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import SettingsPanel from "./SettingsPanel";

it("reflects preferences and forwards theme/font/wrap changes", () => {
  const setTheme = vi.fn(),
    setFontSize = vi.fn(),
    setWordWrap = vi.fn();
  render(
    <SettingsPanel
      theme="dark"
      setTheme={setTheme}
      fontSize={14}
      setFontSize={setFontSize}
      wordWrap={false}
      setWordWrap={setWordWrap}
    />,
  );
  expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Light" }));
  expect(setTheme).toHaveBeenCalledWith("light");
  fireEvent.change(screen.getByRole("slider"), { target: { value: "18" } });
  expect(setFontSize).toHaveBeenCalledWith(18);
  fireEvent.click(screen.getByRole("checkbox"));
  expect(setWordWrap).toHaveBeenCalledWith(true);
  expect(screen.getByText("Ctrl / ⌘ S")).toBeInTheDocument();
});
