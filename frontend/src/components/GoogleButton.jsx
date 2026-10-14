import googleLogo from "../assets/google-g.png";

// Official Google asset and light button colors/padding; also works in dark UI.
export default function GoogleButton({ onClick, disabled, pending }) {
  return (
    <button type="button" className="google-button" onClick={onClick} disabled={disabled} aria-busy={pending}>
      <img src={googleLogo} width="20" height="20" alt="" />
      <span>{pending ? "Connecting…" : "Continue with Google"}</span>
    </button>
  );
}
