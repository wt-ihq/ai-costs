import "server-only";
import { createSlackClient, type SlackClient } from "./slack-client";

/** The ONLY reader of SLACK_BOT_TOKEN (server-only keeps it out of any client bundle). */
export function slackClientFromEnv(): SlackClient {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN is not set");
  return createSlackClient(token);
}

/** Base for dashboard links in DMs. Production never falls back to localhost (links would be dead). */
export function appBaseUrl(): string {
  const explicit = process.env.APP_BASE_URL?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (prod) return `https://${prod}`;
  if (process.env.NODE_ENV === "production") throw new Error("Set APP_BASE_URL or VERCEL_PROJECT_PRODUCTION_URL");
  return "http://localhost:3000";
}
