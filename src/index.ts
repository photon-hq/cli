#!/usr/bin/env node
import {
  DeviceFlowDenied,
  DeviceFlowExpired,
  NotAuthenticatedError,
  SessionExpiredError,
} from '~/lib/errors.ts';
import { die } from '~/lib/output.ts';
import { startUpdateNotifier } from '~/lib/update-check.ts';
import { buildProgram } from '~/program.ts';

startUpdateNotifier();

const program = buildProgram();
program.parseAsync(process.argv).catch(handleTopLevelError);

/**
 * Central error formatter. Commands throw typed errors; this function
 * maps them to a friendly message + actionable hint and exits non-zero.
 *
 * Generic Error / unknown values fall through to a one-liner.
 */
function handleTopLevelError(err: unknown): never {
  if (err instanceof NotAuthenticatedError || err instanceof SessionExpiredError) {
    const flag =
      err.envName === 'production' ? '' : ` --api-host <url> # for "${err.envName}"`;
    die(err.message, {
      hint: `Run \`photon login${flag}\`.`,
    });
  }
  if (err instanceof DeviceFlowDenied) {
    die(err.message, { hint: 'Re-run `photon login` if this was unintentional.' });
  }
  if (err instanceof DeviceFlowExpired) {
    die(err.message, { hint: 'Re-run `photon login` and approve more quickly.' });
  }
  if (err instanceof Error) {
    if (/Unable to connect|fetch failed|ECONNREFUSED/i.test(err.message)) {
      die(err.message, {
        hint: 'Check your connection, or set PHOTON_API_HOST / pass --api-host <url> to target a reachable backend.',
      });
    }
    die(err.message);
  }
  die(String(err));
}
