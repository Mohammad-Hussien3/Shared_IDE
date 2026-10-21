import { useParams } from "react-router-dom";
import WorkspacePage from "./WorkspacePage";

export default function SharedFilePage() {
  const { fileId } = useParams();
  return <WorkspacePage initialSharedFileId={fileId} />;
}
