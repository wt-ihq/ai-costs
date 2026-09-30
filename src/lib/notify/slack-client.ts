/**
 * Minimal Slack Web API client over fetch (no SDK dependency). The token is
 * injected — only src/lib/notify/wiring.ts (server-only) reads it from env —
 * so this module stays unit-testable. Every method is form-encoded, which
 * Slack accepts for all Web API calls (complex args as JSON strings).
 */
export interface SlackClient {
  lookupUserByEmail(email: string): Promise<string | null>;
  openDm(userId: string): Promise<string>;
  uploadImage(png: Uint8Array<ArrayBuffer>, filename: string, title: string): Promise<string>;
  postMessage(channel: string, blocks: unknown[], text: string): Promise<string>;
}

export class SlackApiError extends Error {
  constructor(readonly method: string, readonly code: string) {
    super(`Slack ${method}: ${code}`);
    this.name = "SlackApiError";
  }
}

const API = "https://slack.com/api/";
const MAX_RETRIES = 3;

export function createSlackClient(
  token: string,
  opts: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): SlackClient {
  const f = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function call<T>(method: string, params: Record<string, string>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await f(`${API}${method}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: new URLSearchParams(params).toString(),
      });
      if (res.status === 429 && attempt < MAX_RETRIES) {
        await sleep((Number(res.headers.get("retry-after")) || 1) * 1000);
        continue;
      }
      if (!res.ok) throw new SlackApiError(method, `http_${res.status}`);
      const json = (await res.json()) as { ok: boolean; error?: string } & T;
      if (!json.ok) throw new SlackApiError(method, json.error ?? "unknown_error");
      return json;
    }
  }

  return {
    async lookupUserByEmail(email) {
      try {
        return (await call<{ user: { id: string } }>("users.lookupByEmail", { email })).user.id;
      } catch (err) {
        if (err instanceof SlackApiError && err.code === "users_not_found") return null;
        throw err;
      }
    },
    async openDm(userId) {
      return (await call<{ channel: { id: string } }>("conversations.open", { users: userId })).channel.id;
    },
    async uploadImage(png, filename, title) {
      const { upload_url, file_id } = await call<{ upload_url: string; file_id: string }>("files.getUploadURLExternal", {
        filename,
        length: String(png.byteLength),
      });
      const up = await f(upload_url, { method: "POST", body: png });
      if (!up.ok) throw new SlackApiError("files.upload", `http_${up.status}`);
      // No channel_id: the file stays private to the app until a message references it.
      await call("files.completeUploadExternal", { files: JSON.stringify([{ id: file_id, title }]) });
      return file_id;
    },
    async postMessage(channel, blocks, text) {
      return (
        await call<{ ts: string }>("chat.postMessage", {
          channel,
          text,
          blocks: JSON.stringify(blocks),
          unfurl_links: "false",
          unfurl_media: "false",
        })
      ).ts;
    },
  };
}
