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

export interface DeveloperProfile {
  id: string;
  userId: string;
  // Server-side fields TBD; expand when we render them.
  [key: string]: unknown;
}

export interface OrganizationProfile {
  id: string;
  userId: string;
  [key: string]: unknown;
}

export type ProfileResponse =
  | { type: "developer"; profile: DeveloperProfile }
  | { type: "organization"; profile: OrganizationProfile }
  | null;
