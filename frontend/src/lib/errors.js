// Server bodies may contain secrets or tracebacks. Only curated validation
// messages and developer-authored local messages reach error displays.
export const GOOGLE_MESSAGES = {
  google_failed: "Google sign-in couldn't be completed. Please try again.",
  google_cancelled: "Google sign-in was canceled. You can try again or use your password.",
  google_invalid_state: "This sign-in attempt expired or is no longer valid. Please start again.",
  google_account_exists: "An account already uses this email. Sign in with your password, then connect Google from your dashboard.",
  google_link_conflict: "This Google account or your account is already connected. Sign in using the existing connection.",
  google_verification_required: "Sign in and confirm your current password before connecting Google.",
  google_unavailable: "Google sign-in isn't available yet. Please use your username and password.",
  google_origin: "Open the app using its configured sign-in address and try again.",
};

export const VERIFICATION_MESSAGES = {
  reset_invalid: "This password reset link is invalid or no longer works. Request a new link.",
  reset_expired: "This password reset link has expired. Request a new link.",
  reset_used: "This password reset link has already been used. Sign in or request a new link.",
  current_password_invalid: "The current password is incorrect. Please try again.",
  current_password_required: "Confirm your current password to make this change.",
  account_verification_required: "Enter a valid confirmation code from your email. Codes expire after 10 minutes and can only be used once. Request a new code if needed.",
  account_code_cooldown: "Please wait 60 seconds before requesting another code.",
  account_email_failed: "We couldn't send your confirmation code. Please try again shortly.",
  email_unverified: "Please verify your email first. Check your inbox or request a new verification email.",
  verification_invalid: "This verification link is invalid. Request a new verification email.",
  verification_expired: "This verification link has expired. Request a new verification email.",
  verification_used: "This verification link has already been used. You can go to login.",
  email_delivery_failed: "We couldn't send your verification email. Please try registering again shortly.",
};

export const ERROR_MESSAGES = {
  unexpected: "Something went wrong. Please try again.",
  network: "Could not connect. Check your internet connection and try again.",
  csrf: "We couldn't verify this request. Refresh the page and try again.",
  session: "Your session has expired. Please log in again.",
  login: "Invalid username or password. Please try again.",
  permission: "You don't have permission to do that.",
  missing: "This item is no longer available. Refresh and try again.",
  conflict: "This item has changed or already exists. Refresh and try again.",
  validation: "Please check the information you entered and try again.",
  server: "The service is temporarily unavailable. Please try again shortly.",
  rateLimit: "Too many attempts. Please wait a moment and try again.",
  timeout: "The request took too long. Please try again.",
  tooLarge: "This file is too large. Reduce its size and try again.",
  execution: "Couldn't run your code. Please try again.",
  runner: "Code execution is temporarily unavailable. Please try again later.",
  terminal: "The terminal disconnected. Run your file again to reconnect.",
  executionTimeout: "Your program reached the time limit and was stopped.",
  outputLimit: "Your program produced too much output and was stopped.",
  language: "Choose a supported language: Python, C, or C++.",
  cancelled: "The request was cancelled. Please try again.",
};

const FIELD_LABELS = {
  current_password: "Current password", verification_code: "Confirmation code",
  email: "Email address",
  username: "Username", password: "Password", confirm_password: "Password confirmation",
  name: "Name", content: "File content", language: "Language", parent: "Parent folder", folder: "Folder",
};
const VALIDATION_MESSAGES = {
  "Enter a valid email address.": "Enter a valid email address.",
  "An account with this email already exists. Sign in instead.": "An account with this email already exists. Sign in or request a verification email.",
  "This username or email is unavailable.": "This username or email is unavailable. Sign in or use different details.",
  "A user with that username already exists.": "Username already exists. Choose another username.",
  "Username already exists": "Username already exists. Choose another username.",
  "Username already exists.": "Username already exists. Choose another username.",
  "This username is unavailable.": "This username is unavailable. Choose another username.",
  "Invalid password": "Invalid password. Please try again.",
  "Invalid password.": "Invalid password. Please try again.",
  "Passwords do not match.": "Passwords do not match.",
  "This password is too common.": "This password is too common. Choose a stronger password.",
  "This password is entirely numeric.": "Your password must include more than numbers.",
  "Name already exists": "Name already exists. Choose another name.",
  "Name already exists.": "Name already exists. Choose another name.",
  "Parent folder must belong to this workspace.": "Choose a parent folder in this workspace.",
  "Folder must belong to this workspace.": "Choose a folder in this workspace.",
  "A folder cannot be its own ancestor.": "A folder cannot be moved inside itself or one of its subfolders.",
};

function validationMessage(value, field) {
  if (typeof value !== "string" || value.length > 300) return null;
  if (Object.hasOwn(VALIDATION_MESSAGES, value)) return VALIDATION_MESSAGES[value];
  const label = FIELD_LABELS[field];
  if (label && /^(This field is required\.|This field may not be (blank|null)\.)$/.test(value))
    return `${label} is required.`;
  const length = value.match(/^Ensure this field has (no more than|at least) (\d{1,7}) characters\.$/);
  if (label && length) return `${label} must have ${length[1]} ${length[2]} characters.`;
  const passwordLength = value.match(/^This password is too short\. It must contain at least (\d{1,3}) characters\.$/);
  if (field === "password" && passwordLength) return `Use at least ${passwordLength[1]} characters for your password.`;
  if (field === "password" && /^The password is too similar to the (username|email address|first name|last name)\.$/.test(value))
    return "Choose a password that is different from your personal information.";
  if (field === "username" && value === "Enter a valid username. This value may contain only letters, numbers, and @/./+/-/_ characters.")
    return "Use letters, numbers, or @ . + - _ in your username.";
  if (field === "language" && /^The [a-z0-9+#]{1,12} extension requires language '[a-z0-9+#]{1,12}'\.$/i.test(value))
    return "Choose a language that matches the filename extension.";
  return null;
}

function validationMessages(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const messages = [];
  for (const field of [...Object.keys(FIELD_LABELS), "non_field_errors", "detail"]) {
    if (!Object.hasOwn(data, field)) continue;
    const values = Array.isArray(data[field]) ? data[field].slice(0, 5) : [data[field]];
    const safe = values.map(value => validationMessage(value, field)).filter(Boolean);
    if (safe.length) messages.push(...safe);
    else if (FIELD_LABELS[field]) messages.push(`${FIELD_LABELS[field]} is invalid. Please check it.`);
  }
  return [...new Set(messages)].slice(0, 5);
}

// Use only with local, developer-authored strings, never server text.
export class UserFacingError extends Error {}

export class HttpError extends Error {
  constructor(status, data, context = "general") {
    super();
    this.name = "HttpError";
    this.status = status;
    this.code = data?.code === "csrf_failed" || Object.hasOwn(GOOGLE_MESSAGES, data?.code || "") || Object.hasOwn(VERIFICATION_MESSAGES, data?.code || "") ? data.code : undefined;
    this.csrf = this.code === "csrf_failed" || (status === 403 && /^CSRF verification failed\b/.test(data?.detail || ""));
    this.validation = [400, 422].includes(status) ? validationMessages(data) : [];
    this.fields = Object.keys(FIELD_LABELS).filter(field => data && Object.hasOwn(data, field));
    this.context = context;
    this.message = messageFor(this, context);
  }
}

function messageFor(error, context) {
  if (error instanceof UserFacingError) return error.message;
  if (Object.hasOwn(VERIFICATION_MESSAGES, error?.code || "")) return VERIFICATION_MESSAGES[error.code];
  if (Object.hasOwn(GOOGLE_MESSAGES, error?.code || "")) return GOOGLE_MESSAGES[error.code];
  const status = error?.status;
  if (status === 403 && (error?.code === "csrf_failed" || error?.csrf)) return ERROR_MESSAGES.csrf;
  if (status === 401) return context === "login" ? ERROR_MESSAGES.login : ERROR_MESSAGES.session;
  if (status === 403) return ERROR_MESSAGES.permission;
  if (status === 404) return ERROR_MESSAGES.missing;
  if (status === 409) return ERROR_MESSAGES.conflict;
  if (status === 408 || status === 504) return ERROR_MESSAGES.timeout;
  if (status === 413) return ERROR_MESSAGES.tooLarge;
  if (status === 429) return ERROR_MESSAGES.rateLimit;
  if (status >= 500) return context === "execution" ? ERROR_MESSAGES.runner : ERROR_MESSAGES.server;
  if (status === 400 || status === 422)
    return error instanceof HttpError && error.validation.length ? error.validation.join(" ") : ERROR_MESSAGES.validation;
  if (error?.name === "AbortError") return ERROR_MESSAGES.cancelled;
  if (error?.name === "TimeoutError") return ERROR_MESSAGES.timeout;
  if (/^(Failed to fetch|fetch failed|Load failed|Network offline|NetworkError.*|Network request failed)$/.test(error?.message || ""))
    return ERROR_MESSAGES.network;
  return context === "execution" ? ERROR_MESSAGES.execution : ERROR_MESSAGES.unexpected;
}

const reported = new WeakSet();
function debugError(error, context) {
  if (!import.meta.env.DEV || import.meta.env.MODE === "test") return;
  if (error && typeof error === "object") {
    if (reported.has(error)) return;
    reported.add(error);
  }
  // Never log bodies, headers, URLs, cookies, credentials, source, or raw errors.
  console.debug("[IDE error]", {
    operation: ["general", "login", "register", "logout", "refresh", "save", "execution", "terminal"].includes(context) ? context : "general",
    status: Number.isInteger(error?.status) ? error.status : undefined,
    code: error?.code === "csrf_failed" ? "csrf_failed" : undefined,
    type: error instanceof HttpError ? "HttpError" : error instanceof UserFacingError ? "UserFacingError" : "UnexpectedError",
    fields: error instanceof HttpError ? error.fields : [],
  });
}

export function getErrorMessage(error, context = error?.context || "general") {
  debugError(error, context);
  return messageFor(error, context);
}

export function getTerminalErrorMessage(message) {
  // WS service errors currently have text but no typed codes. Classify known
  // reasons and return local strings. Program stdout/stderr use separate events.
  const text = typeof message === "string" ? message : "";
  let friendly = ERROR_MESSAGES.execution;
  if (/session expired|access revoked/i.test(text)) friendly = ERROR_MESSAGES.session;
  else if (text === "Code execution is not configured for this deployment.") friendly = text;
  else if (/^Execution timed out\.?$/i.test(text)) friendly = ERROR_MESSAGES.executionTimeout;
  else if (/output limit/i.test(text)) friendly = ERROR_MESSAGES.outputLimit;
  else if (/too large/i.test(text)) friendly = ERROR_MESSAGES.tooLarge;
  else if (/no isolated runner for|extension.*not supported|detect the language/i.test(text)) friendly = ERROR_MESSAGES.language;
  else if (/runner unavailable|image.*(?:missing|not installed|not known)|podman/i.test(text)) friendly = ERROR_MESSAGES.runner;
  else if (/file was not found/i.test(text)) friendly = ERROR_MESSAGES.missing;
  debugError(new UserFacingError(friendly), "terminal");
  return friendly;
}
