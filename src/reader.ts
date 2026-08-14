// Full MIME parsing for a single message, on demand, by byte offset.

import { open } from "node:fs/promises";
import PostalMime from "postal-mime";
import type { ArchiveIndex, Envelope } from "./archive.js";

const BODY_TRUNCATE = 8000;

export interface ParsedMessage {
  id: number;
  date?: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  messageId?: string;
  body: string;
  bodyNote?: string;
  attachments: { filename: string; mimeType: string; size: number }[];
}

async function readRaw(index: ArchiveIndex, env: Envelope): Promise<Buffer> {
  const path = index.kind === "eml" ? env.file! : index.path;
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(env.length);
    await fh.read(buf, 0, env.length, env.offset);
    return buf;
  } finally {
    await fh.close();
  }
}

function addressList(value: any): string | undefined {
  if (!value) return undefined;
  const list = Array.isArray(value) ? value : [value];
  const parts = list.map((a: any) => (a.name ? `${a.name} <${a.address}>` : a.address)).filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

export async function parseMessage(index: ArchiveIndex, env: Envelope): Promise<ParsedMessage> {
  let raw = await readRaw(index, env);
  // The mbox "From sender date" separator line is container metadata, not MIME.
  if (index.kind === "mbox" && raw.subarray(0, 5).toString("latin1") === "From ") {
    const nl = raw.indexOf(0x0a);
    raw = nl >= 0 ? raw.subarray(nl + 1) : raw;
  }
  const email = await PostalMime.parse(raw);

  let body = email.text ?? "";
  let bodyNote: string | undefined;
  if (!body && email.html) {
    body = email.html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    bodyNote = "HTML-only message; tags stripped.";
  }
  if (body.length > BODY_TRUNCATE) {
    body = `${body.slice(0, BODY_TRUNCATE)}… [truncated, ${body.length} chars total]`;
  }

  return {
    id: env.id,
    date: email.date ?? env.date,
    from: addressList(email.from) ?? env.from,
    to: addressList(email.to) ?? env.to,
    cc: addressList(email.cc),
    subject: email.subject ?? env.subject,
    messageId: email.messageId ?? env.messageId,
    body,
    ...(bodyNote ? { bodyNote } : {}),
    attachments: (email.attachments ?? []).map((a: any) => ({
      filename: a.filename ?? "(unnamed)",
      mimeType: a.mimeType ?? "application/octet-stream",
      size: a.content?.byteLength ?? 0,
    })),
  };
}

/** Lowercase text-match against a parsed message's body (for bounded body search). */
export async function bodyMatches(index: ArchiveIndex, env: Envelope, needle: string): Promise<boolean> {
  const parsed = await parseMessage(index, env);
  return parsed.body.toLowerCase().includes(needle.toLowerCase());
}
