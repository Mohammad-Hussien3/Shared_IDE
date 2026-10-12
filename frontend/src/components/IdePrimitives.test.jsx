import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ResourceDialog, ResizeHandle, SaveIndicator } from "./IdePrimitives";
import { deferred } from "../test/workspaceFixtures";

it("dialog trims input, blocks duplicate submissions and closes after success", async () => {
  const user = userEvent.setup();
  const gate = deferred();
  const onSubmit = vi.fn(() => gate.promise),
    onClose = vi.fn();
  render(
    <ResourceDialog
      dialog={{
        title: "New file",
        label: "Name",
        submitLabel: "Create",
        onSubmit,
      }}
      onClose={onClose}
    />,
  );
  expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  await user.type(screen.getByRole("textbox"), " main.py ");
  await user.click(screen.getByRole("button", { name: "Create" }));
  expect(onSubmit).toHaveBeenCalledWith("main.py");
  expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  gate.resolve();
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});
it("dialog reports a rejected operation and remains available for retry/cancel", async () => {
  const onClose = vi.fn();
  render(
    <ResourceDialog
      dialog={{
        title: "Rename",
        value: "file",
        onSubmit: vi.fn().mockRejectedValue(new Error("HTTP 400: invalid")),
      }}
      onClose={onClose}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "HTTP 400: invalid",
  );
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onClose).toHaveBeenCalled();
});
it("save indicator represents Saved, Unsaved, and Saving", () => {
  const { container, rerender } = render(<SaveIndicator status="Saved" />);
  expect(screen.getByText("Saved")).toBeInTheDocument();
  rerender(<SaveIndicator status="Unsaved" />);
  expect(container.querySelector(".dirty-dot")).toBeInTheDocument();
  rerender(<SaveIndicator status="Saving…" />);
  expect(container.querySelector(".spin")).toBeInTheDocument();
});
it("resize keyboard operations clamp to minimum and maximum", () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <ResizeHandle
      orientation="vertical"
      value={190}
      min={190}
      max={200}
      onChange={onChange}
      label="Resize"
    />,
  );
  fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });
  expect(onChange).toHaveBeenLastCalledWith(190);
  fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });
  expect(onChange).toHaveBeenLastCalledWith(200);
  rerender(
    <ResizeHandle
      orientation="horizontal"
      value={200}
      min={140}
      max={300}
      onChange={onChange}
      label="Resize"
    />,
  );
  fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowUp" });
  expect(onChange).toHaveBeenLastCalledWith(220);
});
