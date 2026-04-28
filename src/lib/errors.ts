/**
 * Typed errors that the central handler in `src/index.ts` formats with
 * actionable hints. Keep messages short and factual — the hint goes in
 * the central handler, not here, so we don't double-print "Run `photon
 * login`..." once in the message and again in the hint.
 */

export class NotAuthenticatedError extends Error {
  constructor(public envName: string) {
    super(`Not authenticated for environment "${envName}".`);
    this.name = "NotAuthenticatedError";
  }
}

export class DeviceFlowDenied extends Error {
  constructor() {
    super("Authorization was denied.");
    this.name = "DeviceFlowDenied";
  }
}

export class DeviceFlowExpired extends Error {
  constructor() {
    super("Device code expired.");
    this.name = "DeviceFlowExpired";
  }
}

export class UnknownEnvError extends Error {
  constructor(name: string, available: string[]) {
    super(
      `Unknown environment "${name}". Available: ${available.join(", ")}.`
    );
    this.name = "UnknownEnvError";
  }
}

export class SessionExpiredError extends Error {
  constructor(public envName: string) {
    super(`Session expired for "${envName}".`);
    this.name = "SessionExpiredError";
  }
}
