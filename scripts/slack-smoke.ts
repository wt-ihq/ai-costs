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
import { createSlackClient, SlackApiError } from "@/lib/notify/slack-client";
import { deflateSync, inflateSync } from "node:zlib";

process.loadEnvFile(".env.local");

// CRC32 implementation: precomputed table, same as PNG spec.
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length, false);
  const crcBuf = new Uint8Array(typeBytes.length + data.length);
  crcBuf.set(typeBytes);
  crcBuf.set(data, typeBytes.length);
  const crcVal = new Uint8Array(4);
  new DataView(crcVal.buffer).setUint32(0, crc32(crcBuf), false);
  const result = new Uint8Array(4 + typeBytes.length + data.length + 4);
  result.set(len);
  result.set(typeBytes, 4);
  result.set(data, 4 + typeBytes.length);
  result.set(crcVal, 4 + typeBytes.length + data.length);
  return result;
}

export function makeTestPng(): Uint8Array<ArrayBuffer> {
  const width = 240;
  const height = 80;
  const orange = new Uint8Array([245, 158, 11]); // RGB
  const white = new Uint8Array([255, 255, 255]);

  // Build raw scanlines: 1 filter byte (0 = no filter) + RGB data per pixel
  const rawData = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    rawData[row] = 0; // filter byte
    for (let x = 0; x < width; x++) {
      const color = x < width / 2 ? orange : white;
      rawData[row + 1 + x * 3] = color[0];
      rawData[row + 1 + x * 3 + 1] = color[1];
      rawData[row + 1 + x * 3 + 2] = color[2];
    }
  }

  const idatData = deflateSync(rawData);

  // Build PNG: signature + IHDR + IDAT + IEND
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = new Uint8Array(13);
  new DataView(ihdrData.buffer).setUint32(0, width, false);
  new DataView(ihdrData.buffer).setUint32(4, height, false);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: RGB
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = chunk("IHDR", ihdrData);
  const idat = chunk("IDAT", idatData);
  const iend = chunk("IEND", new Uint8Array(0));

  const png = new Uint8Array(signature.length + ihdr.length + idat.length + iend.length);
  png.set(signature);
  png.set(ihdr, signature.length);
  png.set(idat, signature.length + ihdr.length);
  png.set(iend, signature.length + ihdr.length + idat.length);

  // Validate: inflate IDAT and check length
  const idatPayload = idat.slice(4 + 4, idat.length - 4);
  const inflated = inflateSync(idatPayload);
  const expectedLen = (width * 3 + 1) * height;
  if (inflated.length !== expectedLen) {
    throw new Error(`PNG IDAT validation failed: expected ${expectedLen} bytes, got ${inflated.length}`);
  }

  return png as Uint8Array<ArrayBuffer>;
}

async function main() {
  const token = process.env.SLACK_BOT_TOKEN;
  const email = process.env.SLACK_PREVIEW_EMAIL;
  if (!token || !email) throw new Error("Set SLACK_BOT_TOKEN and SLACK_PREVIEW_EMAIL in .env.local");
  const slack = createSlackClient(token);

  const user = await slack.lookupUserByEmail(email);
  if (!user) throw new Error(`No Slack user for ${email}`);
  console.log(`Slack user ${user.id}, time zone ${user.tz ?? "(none)"}`);
  const png = makeTestPng();
  const fileId = await slack.uploadImage(png, "smoke.png", "SMOKE TEST CHART");
  const channel = await slack.openDm(user.id);

  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: "*AI Spend smoke test*\nThe chart below should render inside this message." } },
    { type: "image", slack_file: { id: fileId }, alt_text: "smoke test chart" },
  ];

  let ts: string;
  try {
    ts = await slack.postMessage(channel, blocks, "AI Spend smoke test");
  } catch (err) {
    // Retry once on invalid_blocks (Slack may reject a just-uploaded slack_file block)
    if (err instanceof SlackApiError && err.code.startsWith("invalid_blocks")) {
      console.log(`${err.message}, retrying...`);
      await new Promise((r) => setTimeout(r, 2000));
      try {
        ts = await slack.postMessage(channel, blocks, "AI Spend smoke test");
      } catch (err2) {
        throw new Error(`Image block rejected twice: ${err2 instanceof SlackApiError ? err2.code : String(err2)}`);
      }
    } else {
      throw err;
    }
  }

  console.log(`OK — posted ts=${ts} with file ${fileId}. Check the DM from AI Spend.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
