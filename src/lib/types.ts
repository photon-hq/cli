/**
 * Local DTOs for API responses we consume.
 *
 * Most response shapes are now fully typed by the `@photon-ai/dashboard-api`
 * package and inferred end-to-end through the Eden treaty client, so commands
 * read `data` directly without a hand-rolled cast. Add a DTO here only when the
 * published contract genuinely degrades a shape (e.g. to `Record<string, any>`)
 * and the CLI needs a typed view of it — cast at the API boundary, never deep
 * in command logic.
 */

export type ProjectCreateWarningCode =
  | "owner_enrollment_failed"
  | "owner_phone_missing"
  | "shared_line_unavailable";

export interface ProjectCreateWarning {
  code: ProjectCreateWarningCode;
  message: string;
}

export interface ProjectCreateResult {
  error?: string;
  id?: string;
  ownerStatus?: unknown;
  warning?: unknown;
}

export interface PlatformToggleWarning {
  code: "imessage_connection_missing";
  message: string;
}

export interface PlatformToggleResult {
  error?: string;
  platforms?: Record<string, boolean>;
  success?: true;
  warning?: unknown;
}

export type SpectrumUserAddFailureCode =
  | "imessage_not_enabled"
  | "shared_line_unavailable"
  | "shared_user_create_failed"
  | "shared_user_limit_reached";

export interface SpectrumUserAddFailure {
  code: SpectrumUserAddFailureCode;
  message: string;
}
