/**
 * Slack smoke test / the step-0 private-image check (spec §10.2).
 *
 * Uploads a small PNG privately (no channel), then DMs SLACK_PREVIEW_EMAIL a
 * message whose image block references it by slack_file id — the exact
 * shape renderDigest emits. Look in Slack: the orange bars must render
 * INSIDE the message, under the text.
 *
 * Run: npx tsx scripts/slack-smoke.ts   (reads SLACK_BOT_TOKEN + SLACK_PREVIEW_EMAIL from .env.local)
 */
import { createSlackClient } from "@/lib/notify/slack-client";

process.loadEnvFile(".env.local");

// 240×80 test PNG (orange bars on white).
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAPAAAABQCAIAAACoK28rAAABDklEQVR42u3SoQ0AIBAEwfP0b+kS/ZQAQQGZDfrEMynpo+IEAloCWgJaAlpAS0BLQEtAS0ALaAloCWgJaAlo3dfo7fgBLaAloCWgBTTQAhpoAS0BLexW7IAW0EALaAloAQ20gAZaQAMtoIUd0AIaaAENtIAGGmigBTTQAhpoAQ00dpaBBhpoAQ20sAMaaKCBBtoy0EADLaCBxs4y0EBbBhpoAS0BLexW7IAW0EALaAloAQ20gAZaQAMtoIUd0AIaaAENtIAGGmigBTTQAhpoAQ00dpaBBhpoAQ20sAMaaKCBBtoy0EADLaCBxs4y0EBbBhpoAS0BLexW7IAW0EALaAloAQ20gAZaQAMtoIUd0AIaaAENtIAGGmigBTTQAhpoAQ00dpaBBhpoAQ20sAMaaKCBBtoy0EALaKAtvwfaoS0D7QstA23ZMtCWgQbaMtAObRloy5aBtmy54hyWgXZoy0Bbtgy0ZctAWwbaOSwD7dCWgbZsGWjLlveWJ2b3dWFTrP1+AAAAAElFTkSuQmCC";

async function main() {
  const token = process.env.SLACK_BOT_TOKEN;
  const email = process.env.SLACK_PREVIEW_EMAIL;
  if (!token || !email) throw new Error("Set SLACK_BOT_TOKEN and SLACK_PREVIEW_EMAIL in .env.local");
  const slack = createSlackClient(token);

  const userId = await slack.lookupUserByEmail(email);
  if (!userId) throw new Error(`No Slack user for ${email}`);
  const png = new Uint8Array(Buffer.from(PNG_B64, "base64")) as Uint8Array<ArrayBuffer>;
  const fileId = await slack.uploadImage(png, "smoke.png", "SMOKE TEST CHART");
  const channel = await slack.openDm(userId);
  const ts = await slack.postMessage(
    channel,
    [
      { type: "section", text: { type: "mrkdwn", text: "*AI Spend smoke test*\nThe chart below should render inside this message." } },
      { type: "image", slack_file: { id: fileId }, alt_text: "smoke test chart" },
    ],
    "AI Spend smoke test",
  );
  console.log(`OK — posted ts=${ts} with file ${fileId}. Check the DM from AI Spend.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
