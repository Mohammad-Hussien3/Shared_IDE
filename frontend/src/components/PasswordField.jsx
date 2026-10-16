import { useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";

export default function PasswordField({ label, value, onChange, disabled, current = false,
  onFocus, onBlur, onVisibilityChange, inputProps = {}, children }) {
  const [visible, setVisible] = useState(false);
  const id = useId();
  return <div className="field-label account-password-label" onFocus={onFocus} onBlur={onBlur}>
    <label htmlFor={id}>{label}</label>
    <span className="account-password-input">
      <input {...inputProps} id={id} type={visible ? "text" : "password"} value={value}
        onChange={event => onChange(event.target.value)} required maxLength={128}
        autoComplete={current ? "current-password" : "new-password"} disabled={disabled} />
      <button type="button" className="icon-button" aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
        aria-pressed={visible} onClick={() => { setVisible(!visible); onVisibilityChange?.(!visible); }} disabled={disabled}>
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </span>
    {children}
  </div>;
}
