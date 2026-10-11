const LANGUAGE_EXTENSIONS = {
  python: ".py",
  javascript: ".js",
  typescript: ".ts",
  java: ".java",
  cpp: ".cpp",
  "c++": ".cpp",
  c: ".c",
  csharp: ".cs",
  "c#": ".cs",
  go: ".go",
  rust: ".rs",
  php: ".php",
  ruby: ".rb",
  kotlin: ".kt",
  swift: ".swift",
  html: ".html",
  css: ".css",
  json: ".json",
  xml: ".xml",
  sql: ".sql",
  bash: ".sh",
  shell: ".sh",
};
const EXTENSION_LANGUAGES = {
  py: "python",
  js: "javascript",
  ts: "typescript",
  java: "java",
  cpp: "cpp",
  c: "c",
  cs: "csharp",
  go: "go",
  rs: "rust",
  php: "php",
  rb: "ruby",
  kt: "kotlin",
  swift: "swift",
  html: "html",
  css: "css",
  json: "json",
  xml: "xml",
  sql: "sql",
  sh: "bash",
};
const LANGUAGE_ALIASES = { "c++": "cpp", "c#": "csharp", shell: "bash" };

function hasFilenameExtension(name) {
  return /\.[^./\\]+$/.test(name) && name.lastIndexOf(".") > 0;
}

function languageFromFilename(name) {
  if (!hasFilenameExtension(name)) return "";
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return EXTENSION_LANGUAGES[extension] || "";
}

function detectLanguageFromContent(source) {
  const signatures = {
    python: [
      /^\s*(?:async\s+)?def\s+\w+\s*\(/m,
      /^\s*(?:from\s+[\w.]+\s+import|import\s+[\w.]+)/m,
      /\b(?:None|True|False|lambda|self)\b/,
      /\bprint\s*\(/,
    ],
    c: [
      /^\s*#\s*include\s*[<"](?:stdio|stdlib|string|stdbool|stdint)\.h[>"]/m,
      /\b(?:printf|scanf|puts|fopen|malloc|free)\s*\(/,
    ],
    cpp: [
      /^\s*#\s*include\s*[<"](?:iostream|bits\/stdc\+\+\.h)[>"]/m,
      /\bstd::(?:cout|cin|cerr)\b/,
      /\b(?:cout|cin)\s*<</,
    ],
  };
  const candidates = Object.entries(signatures)
    .filter(([, markers]) => markers.some((marker) => marker.test(source)))
    .map(([language]) => language);
  return candidates.length === 1 ? candidates[0] : "";
}

function replaceFileInTree(nodes, fileId, updatedFile) {
  return nodes.map((node) => {
    if (node.type === "file" && String(node.id) === String(fileId)) {
      return { ...node, ...updatedFile, type: "file" };
    }
    if (node.type === "folder") {
      return {
        ...node,
        children: replaceFileInTree(node.children || [], fileId, updatedFile),
      };
    }
    return node;
  });
}

function normalizeFilename(name, language) {
  const extension = LANGUAGE_EXTENSIONS[LANGUAGE_ALIASES[language] || language];
  if (!extension) return name;
  let normalized = name;
  while (normalized.toLowerCase().endsWith(extension + extension)) {
    normalized = normalized.slice(0, -extension.length);
  }
  return normalized;
}

function getFileName(file) {
  const name = file?.name || "";
  if (hasFilenameExtension(name)) return name;
  const storedLanguage = file?.language?.trim().toLowerCase();
  const language = LANGUAGE_ALIASES[storedLanguage] || storedLanguage;
  const extension = LANGUAGE_EXTENSIONS[language];
  if (!extension) return name;
  return `${name}${extension}`;
}

function flattenFiles(nodes = [], parent = "") {
  return nodes.flatMap((node) => {
    const path = parent ? `${parent}/${node.name}` : node.name;
    return node.type === "file"
      ? [{ ...node, path }]
      : flattenFiles(node.children || [], path);
  });
}

function findFileById(nodes = [], fileId) {
  for (const node of nodes) {
    if (node.type === "file" && String(node.id) === String(fileId)) return node;
    const nestedMatch = findFileById(node.children || [], fileId);
    if (nestedMatch) return nestedMatch;
  }
  return null;
}

function findFolderName(nodes = [], folderId) {
  for (const node of nodes) {
    if (node.type === "folder" && node.id === folderId) return node.name;
    const nestedName = findFolderName(node.children || [], folderId);
    if (nestedName) return nestedName;
  }
  return "";
}

function findFolderPath(nodes = [], folderId, ancestors = []) {
  for (const node of nodes) {
    if (node.type !== "folder") continue;
    const path = [...ancestors, node.id];
    if (String(node.id) === String(folderId)) return path;
    const nestedPath = findFolderPath(node.children || [], folderId, path);
    if (nestedPath.length) return nestedPath;
  }
  return [];
}

export function languageFor(file) {
  const filenameLanguage = languageFromFilename(file?.name || "");
  const storedLanguage = file?.language?.trim().toLowerCase();
  return (
    filenameLanguage ||
    LANGUAGE_ALIASES[storedLanguage] ||
    storedLanguage ||
    "plaintext"
  );
}

export function findParentId(nodes, id, parent = null) {
  for (const node of nodes) {
    if (node.id === id) return parent;
    if (node.children) {
      const result = findParentId(node.children, id, node.id);
      if (result !== undefined) return result;
    }
  }
  return undefined;
}

export {
  LANGUAGE_EXTENSIONS,
  hasFilenameExtension,
  languageFromFilename,
  detectLanguageFromContent,
  normalizeFilename,
  getFileName,
  flattenFiles,
  findFileById,
  findFolderName,
  findFolderPath,
  replaceFileInTree,
};
