import Editor from "@monaco-editor/react";
import { useEffect } from "react";
import { monaco } from "../lib/monaco";

export default function CodeEditor({ workspaceId, ...props }) {
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
  return <Editor {...props} />;
}
