import { useId } from "react";
import { Check, CircleAlert } from "lucide-react";

export default function AuthFormField({ label, icon: Icon, feedback, invalid, valid, ...inputProps }) {
  const id = useId();
  return <div className="spark-field" data-invalid={Boolean(invalid)}>
    <label htmlFor={id}>{label}</label>
    <div className="spark-input-wrap">
      <Icon size={17} aria-hidden="true" />
      <input {...inputProps} id={id} aria-invalid={invalid || undefined} aria-describedby={feedback ? `${id}-feedback` : undefined} />
      {valid && !invalid && <Check className="spark-input-check" size={16} aria-hidden="true" />}
    </div>
    {feedback && <p id={`${id}-feedback`} className="spark-field-feedback" data-invalid={Boolean(invalid)}>
      {invalid && <CircleAlert size={12} aria-hidden="true" />}{feedback}
    </p>}
  </div>;
}

export function PasswordStrength({ password }) {
  const variety = new Set(password).size;
  const score = !password ? 0 : password.length < 8 ? 1 : Math.min(4,
    1 + Number(password.length >= 12) + Number(variety >= 8) + Number(/[a-z]/i.test(password) && /[^a-z]/i.test(password)),
  );
  const labels = ["Use 8 or more characters", "Needs a little more", "A good start", "Getting stronger", "Looking strong"];
  return <div className="spark-strength" data-score={score}>
    <div className="spark-strength-bars" role="meter" aria-label="Estimated password strength"
      aria-valuemin={0} aria-valuemax={4} aria-valuenow={score} aria-valuetext={labels[score]}>
      {[1, 2, 3, 4].map(level => <span key={level} data-filled={level <= score} />)}
    </div>
    <span>{labels[score]}<span className="spark-strength-estimate">Strength estimate</span></span>
  </div>;
}
