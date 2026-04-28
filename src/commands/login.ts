import type { Command } from "@commander-js/extra-typings";
import { spinner } from "@clack/prompts";
import open from "open";
import { CLI_CLIENT_ID, CLI_SCOPE, getAuthClient } from "~/lib/auth-client.ts";
import { resolveEnv } from "~/lib/config.ts";
import { saveCredentials } from "~/lib/credentials.ts";
import {
  DeviceFlowDenied,
  DeviceFlowExpired,
} from "~/lib/errors.ts";
import { c, die, formatApiError } from "~/lib/output.ts";

interface LoginOpts {
  env?: string;
  browser?: boolean;
}

export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description("authenticate via the device authorization flow")
    .option("-e, --env <name>", "environment to log into (defaults to current)")
    .option("--no-browser", "don't auto-open the verification URL")
    .action(async (opts: LoginOpts) => {
      try {
        await runLogin(opts);
      } catch (err) {
        if (err instanceof DeviceFlowDenied || err instanceof DeviceFlowExpired) {
          die(err.message);
        }
        throw err;
      }
    });
}

async function runLogin({ env: envOverride, browser = true }: LoginOpts): Promise<void> {
  const env = await resolveEnv(envOverride);
  console.log(c.info(`Authenticating to ${c.bold(env.name)} ${c.dim(`(${env.url})`)}`));

  const auth = getAuthClient(env.url);

  // Step 1 — request device + user codes. Network failures throw here, so
  // wrap in try/catch and surface a contextful message.
  let codeResp: Awaited<ReturnType<typeof auth.device.code>>;
  try {
    codeResp = await auth.device.code({
      client_id: CLI_CLIENT_ID,
      scope: CLI_SCOPE,
    });
  } catch (err) {
    die(
      `Could not reach ${env.url} — ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (codeResp.error || !codeResp.data) {
    die(`Failed to start device flow: ${formatApiError(codeResp.error)}`);
  }
  const {
    device_code,
    user_code,
    verification_uri,
    verification_uri_complete,
    interval = 5,
    expires_in = 1800,
  } = codeResp.data;

  console.log();
  console.log(`  ${c.dim("Visit:")} ${c.underline(c.cyan(verification_uri))}`);
  console.log(`  ${c.dim("Code: ")} ${c.bold(user_code)}`);
  console.log();

  // Best-effort: open the verification URL with user_code prefilled.
  if (browser) {
    const target = verification_uri_complete ?? verification_uri;
    try {
      await open(target);
      console.log(c.dim(`  Opened ${target}`));
    } catch {
      // The user can still copy the URL manually — don't crash on open failure.
    }
  } else {
    console.log(c.dim("  --no-browser set; open the URL above manually"));
  }
  console.log();

  // Step 2 — poll for the access token.
  const sp = spinner();
  sp.start(`Waiting for approval (polling every ${interval}s)`);

  const accessToken = await pollForToken({
    auth,
    deviceCode: device_code,
    initialInterval: interval,
    expiresInSec: expires_in,
    onSlowDown: (next) => {
      sp.message(`Server asked us to slow down — polling every ${next}s`);
    },
  }).catch((err) => {
    sp.error(err instanceof Error ? err.message : "Failed");
    throw err;
  });

  sp.stop("Authorized");

  // Step 3 — fetch user info via the freshly-issued token.
  const sessionResp = await auth.getSession({
    fetchOptions: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });
  const user = sessionResp.data?.user;
  if (!user) {
    die(
      "Token issued but session lookup failed — server might be misconfigured."
    );
  }

  await saveCredentials({
    accessToken,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
    },
    envName: env.name,
    apiUrl: env.url,
    issuedAt: new Date().toISOString(),
  });

  console.log();
  console.log(
    c.success(`Logged in to ${c.bold(env.name)} as ${c.bold(user.email)}`)
  );
}

interface PollOpts {
  auth: ReturnType<typeof getAuthClient>;
  deviceCode: string;
  initialInterval: number;
  expiresInSec: number;
  onSlowDown: (newInterval: number) => void;
}

async function pollForToken(opts: PollOpts): Promise<string> {
  let interval = opts.initialInterval;
  const deadline = Date.now() + opts.expiresInSec * 1000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));

    const resp = await opts.auth.device.token({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: opts.deviceCode,
      client_id: CLI_CLIENT_ID,
    });

    if (resp.data?.access_token) {
      return resp.data.access_token;
    }

    // Poll errors are normal flow control for device authorization.
    const errorCode = extractErrorCode(resp.error);
    const status = extractErrorStatus(resp.error);

    // HTTP 429 is rate limiting from the server (not a device-flow code) —
    // RFC 8628 says treat like slow_down: back off and keep polling.
    if (status === 429) {
      interval += 10;
      opts.onSlowDown(interval);
      continue;
    }

    switch (errorCode) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5;
        opts.onSlowDown(interval);
        continue;
      case "access_denied":
        throw new DeviceFlowDenied();
      case "expired_token":
        throw new DeviceFlowExpired();
      default:
        throw new Error(`Device flow error: ${formatApiError(resp.error)}`);
    }
  }
  throw new DeviceFlowExpired();
}

function extractErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "error" in error) {
    const code = (error as { error: unknown }).error;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function extractErrorStatus(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error) {
    const s = (error as { status: unknown }).status;
    return typeof s === "number" ? s : undefined;
  }
  return undefined;
}
