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
  createdAt: string;
  updatedAt: string;
}

export interface SpectrumUser {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
}
