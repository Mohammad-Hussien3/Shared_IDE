import { vi } from "vitest";
export const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
export const FILE_ID = "22222222-2222-4222-8222-222222222222";
export const FOLDER_ID = "33333333-3333-4333-8333-333333333333";
export const SECOND_ID = "44444444-4444-4444-8444-444444444444";
export const apiRoot = `http://api.test/api/workspaces/${WORKSPACE_ID}/`;
export const fileUrl = (id = FILE_ID) => `${apiRoot}files/${id}/`;
export const response = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: "Request failed",
  json: async () => structuredClone(data),
});
export const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

export class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];
  readyState = 0;
  constructor(url) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.();
  });
  open() {
    this.readyState = 1;
    this.onopen?.();
    this.emit({ type: "authenticated" });
  }
  emit(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

export function createApi() {
  let sequence = 10;
  const files = [
    {
      id: FILE_ID,
      name: "main.py",
      language: "python",
      content: 'print("saved")',
      folder: null,
    },
    {
      id: SECOND_ID,
      name: "nested.cpp",
      language: "cpp",
      content: "#include <iostream>",
      folder: FOLDER_ID,
    },
  ];
  const folders = [{ id: FOLDER_ID, name: "src", parent: null }];
  const children = (parent = null) => [
    ...files
      .filter((f) => f.folder === parent)
      .map((f) => ({ ...f, type: "file" })),
    ...folders
      .filter((f) => f.parent === parent)
      .map((f) => ({ ...f, type: "folder", children: children(f.id) })),
  ];
  const requests = [];
  const interceptors = [];
  const fetch = vi.fn(async (url, options = {}) => {
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ url, method, body });
    const index = interceptors.findIndex(
      (i) => i.method === method && i.url === url,
    );
    if (index >= 0) return interceptors.splice(index, 1)[0].handle(body);
    if (url === apiRoot && method === "GET")
      return response({
        id: WORKSPACE_ID,
        name: "Test workspace",
        children: children(),
      });
    if (method === "GET" && /\/sharing\/(files|invitations)\/(\?.*)?$/.test(url)) return response([]);
    const match = url.match(/\/(files|folders)\/(?:([^/]+)\/)?$/);
    if (!match || !url.startsWith(apiRoot))
      throw new Error(`Unexpected request ${method} ${url}`);
    const list = match[1] === "files" ? files : folders;
    const record = list.find((item) => item.id === match[2]);
    if (method === "POST") {
      const id = `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
      const created =
        match[1] === "files"
          ? { id, folder: null, content: "", language: "", ...body }
          : { id, parent: null, ...body };
      list.push(created);
      return response(created, 201);
    }
    if (!record) return response({ detail: "Not found" }, 404);
    if (method === "GET") return response(record);
    if (method === "PATCH") {
      Object.assign(record, body);
      return response(record);
    }
    if (method === "DELETE") {
      const remove = (id) => {
        folders.filter((f) => f.parent === id).forEach((f) => remove(f.id));
        for (let i = files.length - 1; i >= 0; i--)
          if (files[i].id === id || files[i].folder === id) files.splice(i, 1);
        const n = folders.findIndex((f) => f.id === id);
        if (n >= 0) folders.splice(n, 1);
      };
      remove(record.id);
      return response({}, 204);
    }
    throw new Error(`Unexpected request ${method} ${url}`);
  });
  return {
    files,
    folders,
    requests,
    fetch,
    intercept(method, url, handle) {
      interceptors.push({ method, url, handle });
    },
  };
}
