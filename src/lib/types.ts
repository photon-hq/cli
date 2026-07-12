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
 * Project row as returned by `GET /api/projects` and `GET /api/projects/:id`.
 * The upstream `.d.ts` for 1.6.x publishes these bodies as `Record<string, any>`
 * (index-signature only), so we cast to this shape at the boundary to get typed
 * field access in list/show/delete commands.
 */
export interface Project {
  id: string;
  name: string;
  location: string;
  status: string;
  platforms: string[];
  isOwner: boolean;
  template: boolean;
  observability: boolean;
  slackChannelId?: string | null;
  slackTeamId?: string | null;
  projectSecret?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Spectrum user row as returned by `GET /api/projects/:id/spectrum/users`
 * and echoed back by `POST` on the same route. Same rationale as `Project`:
 * the 1.6.x published response type is a bare index signature.
 */
export interface SpectrumUser {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
}
