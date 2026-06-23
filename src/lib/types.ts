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
 * Subset of fields the CLI reads from a project. Mirrors what the dashboard
 * returns from `GET /api/projects` (list) and `GET /api/projects/:id` (show).
 * Kept as one shared shape so list/show/delete don't drift apart.
 */
export interface Project {
  id: string;
  name: string;
  status: string;
  location: string;
  platforms: string[];
  template: boolean;
  observability: boolean;
  slackChannelId: string | null;
  slackTeamId: string | null;
  isOwner?: boolean;
  createdAt: string | Date;
  updatedAt: string | Date;
}

/** A Spectrum user as returned by `GET /api/projects/:id/spectrum/users`. */
export interface SpectrumUser {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
}

/** Response envelope for the Spectrum users list route. */
export interface SpectrumUsersPage {
  total: number;
  users: SpectrumUser[];
}
