import { useCallback } from "react";
import { useAuth } from "../auth/context";
import { API_BASE_URL, responseData } from "./api";
export function useSharingApi() {
  const { client } = useAuth();
  return useCallback(async (path, method = "GET", body, signal) => responseData(
    await client.fetch(`${API_BASE_URL}/sharing/${path}`, {
      method, signal, headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  ), [client]);
}
