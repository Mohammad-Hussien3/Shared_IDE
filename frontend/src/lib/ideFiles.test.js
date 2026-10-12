import assert from "node:assert/strict";
import { test } from "vitest";
import {
  detectLanguageFromContent,
  findFileById,
  findFolderName,
  findFolderPath,
  findParentId,
  flattenFiles,
  getFileName,
  languageFromFilename,
  normalizeFilename,
  replaceFileInTree,
} from "./ideFiles.js";

test("display extensions never mutate backend file records or duplicate suffixes", () => {
  const file = { id: "file", name: "main", language: "python" };
  assert.equal(getFileName(file), "main.py");
  assert.equal(file.name, "main");
  assert.equal(getFileName({ name: "main.py", language: "python" }), "main.py");
  assert.equal(getFileName({ name: "main.js", language: "python" }), "main.js");
  assert.equal(getFileName({ name: "README", language: "" }), "README");
  assert.equal(getFileName({ name: "main", language: "c++" }), "main.cpp");
});

test("filename language takes precedence and repeated suffixes normalize", () => {
  assert.equal(languageFromFilename("main.PY"), "python");
  assert.equal(languageFromFilename("main.cpp"), "cpp");
  assert.equal(languageFromFilename("main.c"), "c");
  assert.equal(languageFromFilename("main"), "");
  assert.equal(languageFromFilename("main.unknown"), "");
  assert.equal(normalizeFilename("main.py.py", "python"), "main.py");
});

test("content detection preserves Python, C, C++ and ambiguous cases", () => {
  assert.equal(detectLanguageFromContent('print("Hello")'), "python");
  assert.equal(
    detectLanguageFromContent(
      '#include <stdio.h>\nint main() { puts("Hello"); }',
    ),
    "c",
  );
  assert.equal(
    detectLanguageFromContent(
      '#include <iostream>\nint main() { std::cout << "Hello"; }',
    ),
    "cpp",
  );
  assert.equal(detectLanguageFromContent("x = 1"), "");
  assert.equal(
    detectLanguageFromContent('print("Hello"); printf("Hello");'),
    "",
  );
});

const nestedTree = [
  { id: "root-file", type: "file", name: "README" },
  {
    id: "root-folder",
    type: "folder",
    name: "src",
    children: [
      {
        id: "nested-folder",
        type: "folder",
        name: "examples",
        children: [
          {
            id: "nested-file",
            type: "file",
            name: "main.py",
            language: "python",
          },
        ],
      },
    ],
  },
];

test("recursive lookup works past siblings and finds full folder paths", () => {
  assert.equal(findFolderName(nestedTree, "nested-folder"), "examples");
  assert.deepEqual(findFolderPath(nestedTree, "nested-folder"), [
    "root-folder",
    "nested-folder",
  ]);
  assert.equal(findFileById(nestedTree, "nested-file").name, "main.py");
  assert.equal(findParentId(nestedTree, "nested-file"), "nested-folder");
  assert.equal(findParentId(nestedTree, "root-file"), null);
  assert.equal(flattenFiles(nestedTree)[1].path, "src/examples/main.py");
});

test("renaming a nested file preserves its UUID, tree structure and original records", () => {
  const updated = replaceFileInTree(nestedTree, "nested-file", {
    name: "hello.cpp",
    language: "cpp",
  });
  assert.equal(findFileById(updated, "nested-file").name, "hello.cpp");
  assert.equal(findParentId(updated, "nested-file"), "nested-folder");
  assert.equal(findFileById(nestedTree, "nested-file").name, "main.py");
});
