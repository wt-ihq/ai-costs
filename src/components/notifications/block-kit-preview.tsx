import { parseMrkdwn } from "@/lib/notify/mrkdwn";
import type { SlackBlock } from "@/lib/notify/render";

function Mrk({ text }: { text: string }) {
  return (
    <>
      {parseMrkdwn(text).map((n, i) =>
        n.t === "br" ? <br key={i} /> :
        n.t === "bold" ? <strong key={i} className="font-extrabold">{n.v}</strong> :
        n.t === "link" ? <a key={i} href={n.href} className="text-[#1264a3]">{n.v}</a> :
        <span key={i}>{n.v}</span>,
      )}
    </>
  );
}

function Block({ block, images }: { block: SlackBlock; images: Record<string, string> }) {
  switch (block.type) {
    case "header":
      return <p className="mb-2 text-[15px] font-black">{(block.text as { text: string }).text}</p>;
    case "section":
      return <p className="mt-2"><Mrk text={(block.text as { text: string }).text} /></p>;
    case "image": {
      const src = images[(block.slack_file as { id: string }).id];
      // eslint-disable-next-line @next/next/no-img-element -- data-URL preview of the exact PNG the DM carries
      return src ? <img src={src} alt={block.alt_text as string} className="my-1.5 w-full rounded border border-[#e8e8e8]" /> : null;
    }
    case "context":
      return (
        <div className="mt-1 text-[11.5px] text-[#616061]">
          {(block.elements as { text: string }[]).map((e, i) => <p key={i}><Mrk text={e.text} /></p>)}
        </div>
      );
    case "divider":
      return <hr className="my-3 border-[#e8e8e8]" />;
    case "actions":
      return (
        <div className="mt-3 flex gap-2">
          {(block.elements as { text: { text: string }; url: string }[]).map((e, i) => (
            <a key={i} href={e.url} className="rounded border border-[#bbbabb] px-3 py-0.5 text-[12px] font-bold">{e.text.text}</a>
          ))}
        </div>
      );
    default:
      return null;
  }
}

/** Renders the SAME Block Kit renderDigest sends; chart file ids map to data-URL PNGs. */
export function BlockKitPreview({ blocks, images }: { blocks: SlackBlock[]; images: Record<string, string> }) {
  return (
    <div className="rounded-md bg-white p-4 text-[13px] leading-relaxed text-[#1d1c1d]">
      {blocks.map((b, i) => <Block key={i} block={b} images={images} />)}
    </div>
  );
}
