import { ERROR_MESSAGES, HttpError, UserFacingError } from "./errors";

export const API_BASE_URL = (import.meta.env.VITE_API_URL || "/api").replace(
  /\/$/,
  "",
);
export const WS_BASE_URL = new URL(
  API_BASE_URL,
  window.location.origin,
).href.replace(/^http/, "ws");

export async function responseData(response, context = "general") {
  if (response.status === 204) return {};
  let data;
  try {
    data = await response.json();
  } catch {
    // HTML error pages and malformed success responses are not application data.
    throw new HttpError(response.status, undefined, context);
  }
  if (!response.ok) {
    throw new HttpError(response.status, data, context);
  }
  return data;
}

// Each provider owns its client. Tokens never leave memory or enter a URL.
export function createAuthClient() {
  let access = null;
  let csrf = null;
  let refreshPromise = null;
  let csrfPromise = null;
  let accountPromise = null;
  let generation = 0;
  let userId = null;
  let loggingOut = false;
  let changed = () => {};

  const fetchCSRF = () => {
    if (csrf) return Promise.resolve(csrf);
    if (!csrfPromise) {
      csrfPromise = fetch(`${API_BASE_URL}/auth/csrf/`, {
        credentials: "include",
        cache: "no-store",
      })
        .then(responseData)
        .then((data) => {
          if (typeof data.csrf !== "string" || !data.csrf) {
            throw new UserFacingError(ERROR_MESSAGES.csrf);
          }
          return (csrf = data.csrf);
        })
        .finally(() => {
          csrfPromise = null;
        });
    }
    return csrfPromise;
  };
  const authRequest = async (action, body = {}, token = null) => {
    const send = async () => responseData(
      await fetch(`${API_BASE_URL}/auth/${action}/`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-CSRFToken": await fetchCSRF(),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
      action,
    );
    try {
      return await send();
    } catch (error) {
      // A login in another tab can rotate the shared cookie. Retry only an
      // explicit CSRF rejection (the backend has not performed the action).
      if (error.status !== 403 || error.code !== "csrf_failed") throw error;
      csrf = null;
      return send();
    }
  };
  const acceptSession = (data) => {
    const nextUserId = String(data.user.id);
    // Another tab may have replaced the shared refresh cookie by logging in
    // as someone else. Never replay the previous user's requests as that user.
    if (userId !== null && userId !== nextUserId) generation += 1;
    userId = nextUserId;
    access = data.access;
    csrf = data.csrf || csrf;
    changed(data.user);
    return access;
  };
  const refresh = () => {
    if (!refreshPromise) {
      const version = generation;
      refreshPromise = authRequest("refresh")
        .then((data) => {
          if (version !== generation)
            throw new Error("Session changed. Please log in again.");
          return acceptSession(data);
        })
        .catch((error) => {
          if (
            version === generation &&
            (error.status === 401 || error.status === 403)
          ) {
            access = null;
            csrf = null;
            changed(null, error);
          }
          throw error;
        })
        .finally(() => {
          refreshPromise = null;
        });
    }
    return refreshPromise;
  };
  const getAccessToken = async () => {
    if (loggingOut) throw new Error("Logout is in progress.");
    // Refresh shortly before expiry, also for a new WebSocket connection.
    let expires = 0;
    try {
      expires = JSON.parse(
        atob(access.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
      ).exp;
    } catch {
      /* No valid token yet. */
    }
    if (!access || expires * 1000 < Date.now() + 15000) return refresh();
    return access;
  };
  const sendAccountRequest = async (action, body) => {
    if (refreshPromise) await refreshPromise;
    const version = generation;
    const token = await getAccessToken();
    if (version !== generation || loggingOut) throw new UserFacingError(ERROR_MESSAGES.session);
    const data = await authRequest(`account/${action}`, body, token);
    if (version !== generation || loggingOut) throw new UserFacingError(ERROR_MESSAGES.session);
    if (data.access) {
      // Reject late responses from the old session after credential rotation.
      generation += 1;
      acceptSession(data);
    } else if (data.user) changed(data.user);
    return data;
  };
  const accountRequest = (action, body = {}) => {
    if (accountPromise) return Promise.reject(new UserFacingError("Please wait for your account change to finish."));
    accountPromise = sendAccountRequest(action, body).finally(() => { accountPromise = null; });
    return accountPromise;
  };
  return {
    subscribe(listener) {
      changed = listener;
      return () => {
        changed = () => {};
      };
    },
    restore: refresh,
    getAccessToken,
    verifyEmail: (token) => authRequest("verify-email", { token }),
    resendVerification: (email) => authRequest("resend-verification", { email }),
    requestPasswordReset: (email) => authRequest("password-reset", { email }),
    async confirmPasswordReset(body) {
      if (accountPromise) await accountPromise.catch(() => {});
      if (refreshPromise) await refreshPromise.catch(() => {});
      const data = await authRequest("password-reset/confirm", body);
      // Recovery never logs in. Invalidate in-flight work and drop any old local
      // session, matching the revoked tokens and cleared cookie on the server.
      generation += 1;
      access = null;
      userId = null;
      csrf = null;
      changed(null);
      return data;
    },
    requestAccountVerification: () => accountRequest("verification"),
    updateUsername: (body) => accountRequest("username", body),
    updatePassword: (body) => accountRequest("password", body),
    async loadAccount() {
      const version = generation;
      const data = await responseData(await this.fetch(`${API_BASE_URL}/auth/me/`));
      if (version !== generation || loggingOut) throw new UserFacingError(ERROR_MESSAGES.session);
      changed(data);
      return data;
    },
    async startGoogle(password) {
      if (refreshPromise) await refreshPromise.catch(() => {});
      const link = password !== undefined;
      const token = link ? await getAccessToken() : null;
      const result = await authRequest(link ? "google/link" : "google/start", link ? { password } : {}, token);
      // The server controls this destination; additionally reject arbitrary URLs.
      const url = new URL(result.authorization_url);
      if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth" || url.username || url.password || url.hash) {
        throw new UserFacingError("Google sign-in couldn't be started. Please try again.");
      }
      return url.href;
    },
    async authenticate(action, body) {
      if (refreshPromise) await refreshPromise.catch(() => {});
      generation += 1;
      try {
        const data = await authRequest(action, body);
        // Password signup requires email verification and never creates a session.
        return action === "register" ? data : acceptSession(data);
      } catch (error) {
        if (error.status === 403) csrf = null;
        throw error;
      }
    },
    async logout() {
      loggingOut = true;
      try {
        // A password update may set a replacement cookie. Revoke it after that
        // response arrives, so a late save cannot restore a logged-out session.
        if (accountPromise) await accountPromise.catch(() => {});
        if (refreshPromise) await refreshPromise.catch(() => {});
        await authRequest("logout", {}, access);
        generation += 1;
        access = null;
        userId = null;
        csrf = null;
        changed(null);
      } catch (error) {
        if (error.status === 403) csrf = null;
        throw error;
      } finally {
        loggingOut = false;
      }
    },
    async fetch(url, options = {}) {
      const version = generation;
      const token = await getAccessToken();
      if (options.signal?.aborted || version !== generation || loggingOut)
        throw new Error("Request cancelled.");
      const request = (jwt) =>
        fetch(url, {
          ...options,
          credentials: "omit",
          headers: { ...options.headers, Authorization: `Bearer ${jwt}` },
        });
      let result = await request(token);
      if (version !== generation || loggingOut)
        throw new Error("Session changed. Request cancelled.");
      if (result.status === 401) {
        // Concurrent failures share one rotation; a late 401 reuses the new token.
        const renewed = access !== token && access ? access : await refresh();
        if (version !== generation || loggingOut)
          throw new Error("Session changed. Request cancelled.");
        result = await request(renewed);
        if (result.status === 401) {
          access = null;
          changed(null, new HttpError(401));
        }
      }
      if (version !== generation)
        throw new Error("Session changed. Request cancelled.");
      return result;
    },
  };
}
