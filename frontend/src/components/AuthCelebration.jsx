import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import AuthMascot from "./AuthMascot";
import "../spark-auth.css";

// Lives above the routes so a confirmed success can celebrate without holding
// up navigation or the next page's loading. Never triggered by Google redirects.
export default function AuthCelebration() {
  const location = useLocation();
  const kind = location.state?.authCelebration;
  const [dismissed, setDismissed] = useState(null);
  const confirmed = kind === "registered" || kind === "signed-in";
  useEffect(() => {
    if (!confirmed) return;
    const timer = setTimeout(() => setDismissed(location.key), 1800);
    return () => clearTimeout(timer);
  }, [confirmed, location.key]);
  if (!confirmed || dismissed === location.key) return null;
  return <div className="spark-celebration" role="status">
    <div aria-hidden="true"><AuthMascot expression="celebrating" /></div>
    <span>{kind === "registered" ? "First step done. Check your inbox!" : "You’re in. Let’s build something."}</span>
  </div>;
}
