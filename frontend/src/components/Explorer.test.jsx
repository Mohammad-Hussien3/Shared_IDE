import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import Explorer, { SearchSidebar } from "./Explorer";

const file = { id: "file", type: "file", name: "main", language: "python" };
const tree = [
  {
    id: "root",
    type: "folder",
    name: "src",
    children: [
      { id: "deep", type: "folder", name: "nested", children: [file] },
    ],
  },
];
function props(overrides = {}) {
  return {
    tree,
    workspaceName: "Project",
    expanded: new Set(["root", "deep"]),
    setExpanded: vi.fn(),
    dirtyIds: new Set(["file"]),
    selectedId: "file",
    selectedFolderId: null,
    onSelect: vi.fn(),
    onSelectFolder: vi.fn(),
    onToggle: vi.fn(),
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onRefresh: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}
it("renders nested files, extension display, selection and collapse", () => {
  const p = props();
  const { container, rerender } = render(<Explorer {...p} />);
  const row = screen.getByRole("button", { name: "main.py" });
  expect(row).toHaveAttribute("title", "main.py");
  expect(row.closest(".tree-line")).toHaveClass("selected");
  expect(container.querySelector(".dirty-dot")).toBeInTheDocument();
  fireEvent.click(row);
  expect(p.onSelect).toHaveBeenCalledWith(file);
  fireEvent.click(screen.getByRole("button", { name: "src", exact: true }));
  expect(p.onToggle).toHaveBeenCalledWith("root");
  expect(p.onSelectFolder).toHaveBeenCalledWith("root");
  rerender(<Explorer {...p} expanded={new Set()} />);
  expect(
    screen.queryByRole("button", { name: "main.py" }),
  ).not.toBeInTheDocument();
});
it("context actions use the clicked file parent and keyboard dismissal works", async () => {
  const user = userEvent.setup();
  const p = props();
  render(<Explorer {...p} />);
  fireEvent.contextMenu(screen.getByRole("button", { name: "main.py" }));
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("menuitem", { name: "New Folder" })).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  fireEvent.contextMenu(screen.getByRole("button", { name: "main.py" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "New File" }));
  expect(p.onCreate).toHaveBeenCalledWith("file", "deep");
  fireEvent.contextMenu(screen.getByRole("button", { name: "main.py" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  expect(p.onRename).toHaveBeenCalledWith(file);
});
it("root selection, hover create actions and busy controls use correct destinations", () => {
  const p = props({ selectedFolderId: "deep" });
  const { rerender } = render(<Explorer {...p} />);
  fireEvent.click(
    screen.getByRole("button", { name: "New Folder", exact: true }),
  );
  expect(p.onCreate).toHaveBeenCalledWith("folder", "deep");
  fireEvent.click(screen.getByRole("button", { name: "New file in src" }));
  expect(p.onCreate).toHaveBeenCalledWith("file", "root");
  fireEvent.click(
    screen.getByRole("button", { name: "Select workspace root" }),
  );
  expect(p.onSelectFolder).toHaveBeenCalledWith(null);
  rerender(<Explorer {...p} busy />);
  expect(
    screen.getByRole("button", { name: "New File", exact: true }),
  ).toBeDisabled();
});
it("renders loading, empty and error states with retry", () => {
  const p = props();
  const { container, rerender } = render(<Explorer {...p} loading />);
  expect(container.querySelector(".tree-skeleton")).toBeInTheDocument();
  rerender(<Explorer {...p} tree={[]} />);
  expect(screen.getByText("A fresh workspace")).toBeInTheDocument();
  rerender(<Explorer {...p} error="HTTP 500" />);
  expect(screen.getByText("HTTP 500")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(p.onRefresh).toHaveBeenCalledOnce();
});
it("search finds files by path and displayed extension", () => {
  const select = vi.fn();
  const record = { ...file, path: "src/nested/main" };
  render(<SearchSidebar files={[record]} onSelect={select} />);
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "nested" },
  });
  expect(screen.getByText("1 file found")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /main.py/ }));
  expect(select).toHaveBeenCalledWith(record);
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "missing" },
  });
  expect(screen.getByText("0 files found")).toBeInTheDocument();
});
