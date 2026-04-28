import { createAuthClient } from "better-auth/client";
import { deviceAuthorizationClient } from "better-auth/client/plugins";

/**
 * The CLI's `client_id` for the device authorization flow. Must match an
 * entry in `ALLOWED_DEVICE_CLIENT_IDS` on the server (apps/api/src/auth.ts).
 */
export const CLI_CLIENT_ID = "photon-cli";

/** Standard OAuth scopes — server doesn't validate these but we send them for clarity. */
export const CLI_SCOPE = "openid profile email";

/**
 * Construct a better-auth client for a specific environment's API URL.
 *
 * Returns a client typed with the `deviceAuthorizationClient` plugin —
 * `client.device.code()`, `client.device.token()`, etc. are typed.
 */
export function getAuthClient(baseURL: string) {
  return createAuthClient({
    baseURL,
    plugins: [deviceAuthorizationClient()],
  });
}

export type AuthClient = ReturnType<typeof getAuthClient>;
