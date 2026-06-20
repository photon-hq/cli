/**
 * Lightweight DTOs for API responses we consume.
 *
 * The bundled `PublicApp` type degrades some response shapes to
 * `Record<string, any>` because handlers infer from Drizzle and those
 * generic types don't survive `.d.ts` bundling. We cast at the boundary
 * to these DTOs — drift is possible but the runtime will surface it
 * (and it's only this thin slice that needs maintenance).
 *
 * If a field is added on the server but you don't see it here, that's OK —
 * it's still in the JSON, just not typed. Add it here when the CLI needs it.
 */

export interface Project {
  id: string;
  name: string;
  location: string;
  status: string;
  spectrum: boolean;
  spectrumProjectId: string | null;
  template: boolean;
  observability: boolean;
  subscriptionStatus: string | null;
  createdAt: string; // ISO from Drizzle's timestamp serialization
  updatedAt: string;
}

/**
 * `GET /api/profile` returns the user's onboarding profile row (or null).
 * Replaces the pre-v1.1.0 `{ type, profile }` envelope; the server now
 * returns a single flat record sourced from the `onboarding_profile` table.
 */
export interface ProfileRow {
  id: string;
  userId: string;
  type: "developer" | "organization";
  referralSource: string | null;
  platforms: string[] | null;
  background: string | null;
  companyName: string | null;
}

export type ProfileResponse = ProfileRow | null;
