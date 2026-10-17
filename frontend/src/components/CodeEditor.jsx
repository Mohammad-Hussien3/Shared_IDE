import Editor from "@monaco-editor/react";
import { useEffect } from "react";
import { monaco } from "../lib/monaco";
import useReducedMotion from "../lib/useReducedMotion";

export default function CodeEditor({ workspaceId, ...props }) {
  const reducedMotion = useReducedMotion();
  useEffect(
    () => () => {
      const prefix = `file:///${workspaceId}/`;
      monaco.editor
        .getModels()
        .filter((model) => model.uri.toString().startsWith(prefix))
        .forEach((model) => model.dispose());
    },
    [workspaceId],
  );
  return <Editor {...props} options={{ ...props.options,
    smoothScrolling: reducedMotion ? false : props.options?.smoothScrolling,
    cursorSmoothCaretAnimation: reducedMotion ? "off" : props.options?.cursorSmoothCaretAnimation,
  }} />;
}
