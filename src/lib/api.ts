import { treaty } from "@elysiajs/eden";
import type { PublicApp } from "~/types/api";

const DEFAULT_BASE_URL = "http://localhost:3000";

export function getApi(baseUrl: string = process.env.DASHBOARD_API_URL ?? DEFAULT_BASE_URL) {
  return treaty<PublicApp>(baseUrl, {
    fetch: { credentials: "include" },
  });
}

export type Api = ReturnType<typeof getApi>;
