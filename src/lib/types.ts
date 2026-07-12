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

/**
 * Row shape returned by `GET /api/projects` (and the singular
 * `GET /api/projects/:id`). The published contract degrades this to
 * `Record<string, any>`, so we cast at the API boundary.
 */
export interface Project {
  id: string;
  name: string;
  location: string;
  status: string;
  platforms: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Row shape returned by `GET /api/projects/:id/spectrum/users`
 * (as `data.users[]`). Same rationale as {@link Project}.
 */
export interface SpectrumUser {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
}
