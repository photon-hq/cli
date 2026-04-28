export class NotAuthenticatedError extends Error {
  constructor(public envName: string) {
    super(
      `Not authenticated for environment "${envName}". Run \`dashboard login\`${
        envName === "production" ? "" : ` --env ${envName}`
      }.`
    );
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
    super("Device code expired. Run `dashboard login` again.");
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
    super(
      `Session expired for "${envName}". Run \`dashboard login\`${
        envName === "production" ? "" : ` --env ${envName}`
      }.`
    );
    this.name = "SessionExpiredError";
  }
}
