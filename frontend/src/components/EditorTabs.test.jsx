import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import EditorTabs from "./EditorTabs";

it("shows a workspace placeholder with no open files", () => {
  render(<EditorTabs files={[]} dirtyIds={new Set()} />);
  expect(screen.getByText("Workspace")).toBeInTheDocument();
  expect(screen.queryByRole("tab")).not.toBeInTheDocument();
});
it("marks active and dirty tabs and separates select from close actions", () => {
  const files = [
    { id: "a", name: "main", language: "python" },
    { id: "b", name: "other.cpp", language: "cpp" },
  ];
  const select = vi.fn(),
    close = vi.fn();
  render(
    <EditorTabs
      files={files}
      activeId="a"
      dirtyIds={new Set(["a"])}
      onSelect={select}
      onClose={close}
    />,
  );
  expect(screen.getByRole("tab", { name: /main.py/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "other.cpp" }));
  expect(select).toHaveBeenCalledWith(files[1]);
  fireEvent.click(screen.getByRole("button", { name: "Close main.py" }));
  expect(close).toHaveBeenCalledWith(files[0]);
  expect(select).toHaveBeenCalledTimes(1);
});
