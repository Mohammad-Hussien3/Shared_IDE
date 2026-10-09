import os
import re


EXTENSION_LANGUAGES = {
    ".py": "python",
    ".js": "javascript",
    ".ts": "typescript",
    ".java": "java",
    ".cpp": "cpp",
    ".c": "c",
    ".cs": "csharp",
    ".go": "go",
    ".rs": "rust",
    ".php": "php",
    ".rb": "ruby",
    ".kt": "kotlin",
    ".swift": "swift",
    ".html": "html",
    ".css": "css",
    ".json": "json",
    ".xml": "xml",
    ".sql": "sql",
    ".sh": "bash",
}

SUPPORTED_RUNNERS = {"python", "c", "cpp"}


def language_from_filename(filename):
    """Return a language from a recognized filename extension, if any."""
    extension = os.path.splitext(os.path.basename(filename))[1].lower()
    return EXTENSION_LANGUAGES.get(extension) if extension else None


def has_filename_extension(filename):
    return bool(os.path.splitext(os.path.basename(filename))[1])


def language_from_content(source):
    """Conservatively recognize a few common extensionless source snippets."""
    python_markers = (
        r"(?m)^\s*(?:async\s+)?def\s+\w+\s*\(",
        r"(?m)^\s*class\s+\w+\s*[:(]",
        r"(?m)^\s*(?:from\s+[\w.]+\s+import|import\s+[\w.]+)",
        r"(?m)^\s*(?:if|elif|else|for|while|try|except|with)\b.*:",
        r"\b(?:None|True|False|lambda|self)\b",
        r"\bprint\s*\(",
    )
    javascript_markers = (
        r"\bconsole\.(?:log|error|warn)\s*\(",
        r"\b(?:const|let|var)\s+\w+",
        r"=>",
        r"\bfunction\s+\w+\s*\(",
    )
    java_markers = (r"\bpublic\s+class\s+\w+", r"\bstatic\s+void\s+main\s*\(")
    c_markers = (
        r"(?m)^\s*#\s*include\s*[<\"](?:stdio|stdlib|string|stdbool|stdint)\.h[>\"]",
        r"\b(?:printf|scanf|puts|fopen|malloc|free)\s*\(",
    )
    cpp_markers = (
        r"(?m)^\s*#\s*include\s*[<\"](?:iostream|bits/stdc\+\+\.h)[>\"]",
        r"\bstd::(?:cout|cin|cerr)\b",
        r"\bint\s+main\s*\(\s*(?:int\s+\w+\s*,\s*char\s*\*\s*\w+\[\s*\])?\s*\)",
    )

    evidence = []
    if any(re.search(marker, source) for marker in python_markers):
        evidence.append("python")
    if any(re.search(marker, source) for marker in javascript_markers):
        evidence.append("javascript")
    if any(re.search(marker, source) for marker in java_markers):
        evidence.append("java")
    if any(re.search(marker, source) for marker in c_markers):
        evidence.append("c")
    if any(re.search(marker, source) for marker in cpp_markers):
        evidence.append("cpp")
    return evidence[0] if len(evidence) == 1 else None


def detect_language(filename, source):
    """Prioritize extensions and only inspect source when the name has none."""
    if has_filename_extension(filename):
        extension = os.path.splitext(os.path.basename(filename))[1].lower()
        language = EXTENSION_LANGUAGES.get(extension)
        if language is None:
            return None, f"The {extension} extension is not supported. Add a supported language extension."
        return language, None

    language = language_from_content(source)
    if language is None:
        return None, "Could not confidently detect the language. Add a supported extension such as .py."
    return language, None
