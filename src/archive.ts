// Streaming mbox/eml archive indexer.
// A Takeout mbox can be many GB with 100k+ messages, so the scan keeps only:
//   - a byte-offset index (one small record per message), and
//   - the first 16 KiB of the *current* message, to parse its envelope.
// Full MIME parsing happens later, one message at a time, in reader.ts.

import { open, readdir, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const CHUNK = 8 << 20; // 8 MiB scan chunks
const HEADER_CAPTURE = 16 << 10; // envelope parsing sees at most this much per message
const SEP = Buffer.from("\nFrom ");

export interface Envelope {
  id: number;
  offset: number;
  length: number;
  /** For eml archives: the source file. */
  file?: string;
  date?: string;
  timestamp?: number;
  from?: string;
  to?: string;
  subject?: string;
  messageId?: string;
}

export interface ArchiveIndex {
  kind: "mbox" | "eml";
  path: string;
  messages: Envelope[];
}

// ---------------------------------------------------------------------------
// Header utilities (pure — unit tested directly)

/** Decode RFC 2047 encoded-words: =?charset?B|Q?data?= */
export function decodeWords(value: string): string {
  // Whitespace between adjacent encoded words is ignored per the RFC.
  const joined = value.replace(/(\?=)\s+(=\?)/g, "$1$2");
  return joined.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset: string, enc: string, data: string) => {
    try {
      let bytes: Buffer;
      if (enc.toUpperCase() === "B") {
        bytes = Buffer.from(data, "base64");
      } else {
        bytes = Buffer.from(
          data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))),
          "latin1",
        );
      }
      return new TextDecoder(charset.toLowerCase()).decode(bytes);
    } catch {
      return whole; // unknown charset or bad data — leave the raw word visible
    }
  });
}

/** Parse a raw header block into a lowercased name → decoded value map. */
export function parseHeaders(block: string): Map<string, string> {
  const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
  const headers = new Map<string, string>();
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, decodeWords(line.slice(colon + 1).trim()));
  }
  return headers;
}

function envelopeFromCapture(capture: Buffer, id: number, offset: number, skipFromLine: boolean): Envelope {
  let text = capture.toString("utf8");
  if (skipFromLine) {
    const nl = text.indexOf("\n");
    text = nl >= 0 ? text.slice(nl + 1) : "";
  }
  const blank = text.search(/\r?\n\r?\n/);
  const headers = parseHeaders(blank >= 0 ? text.slice(0, blank) : text);
  const rawDate = headers.get("date");
  const ts = rawDate ? Date.parse(rawDate) : NaN;
  return {
    id,
    offset,
    length: 0, // finalized by the caller once the message end is known
    date: Number.isNaN(ts) ? rawDate : new Date(ts).toISOString(),
    timestamp: Number.isNaN(ts) ? undefined : ts,
    from: headers.get("from"),
    to: headers.get("to"),
    subject: headers.get("subject"),
    messageId: headers.get("message-id"),
  };
}

// ---------------------------------------------------------------------------
// mbox scan

export async function indexMbox(path: string, chunkSize = CHUNK): Promise<ArchiveIndex> {
  const fh = await open(path, "r");
  try {
    const fileSize = (await stat(path)).size;
    if (fileSize === 0) throw new Error(`Not an mbox file (empty): ${path}`);
    const messages: Envelope[] = [];

    let filePos = 0;
    let carry = Buffer.alloc(0); // tail of the previous chunk, so "\nFrom " spanning chunks is still found
    let current: { start: number; capture: Buffer[]; captured: number } | undefined;

    const finalize = (end: number) => {
      if (!current) return;
      const env = envelopeFromCapture(Buffer.concat(current.capture), messages.length, current.start, true);
      env.length = end - current.start;
      messages.push(env);
      current = undefined;
    };

    const startMessage = (start: number) => {
      current = { start, capture: [], captured: 0 };
    };

    while (filePos < fileSize) {
      const chunk = Buffer.alloc(Math.min(chunkSize, fileSize - filePos));
      await fh.read(chunk, 0, chunk.length, filePos);
      const chunkEnd = filePos + chunk.length;

      if (filePos === 0) {
        if (chunk.subarray(0, 5).toString("latin1") !== "From ") {
          throw new Error(`Not an mbox file (does not start with an mbox "From " separator line): ${path}`);
        }
        startMessage(0);
      }

      // Append the slice of this chunk that falls inside the current message's
      // 16 KiB capture window (absolute-offset intersection — segment-safe).
      const captureUpTo = (absHi: number) => {
        if (!current) return;
        const lo = Math.max(filePos, current.start);
        const hi = Math.min(absHi, current.start + HEADER_CAPTURE, chunkEnd);
        if (hi > lo) {
          current.capture.push(Buffer.from(chunk.subarray(lo - filePos, hi - filePos)));
          current.captured += hi - lo;
        }
      };

      // Boundaries: matches in the carry+chunk seam window that extend into
      // this chunk (matches wholly inside the previous chunk were found then).
      const window = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const windowBase = filePos - carry.length;
      const boundaries: number[] = [];
      let searchFrom = 0;
      while (true) {
        const hit = window.indexOf(SEP, searchFrom);
        if (hit === -1) break;
        if (hit + SEP.length > carry.length) boundaries.push(windowBase + hit + 1); // the "F" of "From "
        searchFrom = hit + 1;
      }

      for (const boundary of boundaries) {
        captureUpTo(boundary);
        finalize(boundary);
        startMessage(boundary);
      }
      captureUpTo(chunkEnd);

      carry = Buffer.from(chunk.subarray(Math.max(0, chunk.length - (SEP.length - 1))));
      filePos = chunkEnd;
    }
    finalize(fileSize);

    return { kind: "mbox", path, messages };
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// eml directory scan

async function indexEmlDir(path: string): Promise<ArchiveIndex> {
  const entries = (await readdir(path)).filter((e) => extname(e).toLowerCase() === ".eml").sort();
  if (entries.length === 0) throw new Error(`No .eml files found in directory: ${path}`);
  const messages: Envelope[] = [];
  for (const entry of entries) {
    const file = join(path, entry);
    const size = (await stat(file)).size;
    const fh = await open(file, "r");
    try {
      const head = Buffer.alloc(Math.min(HEADER_CAPTURE, size));
      await fh.read(head, 0, head.length, 0);
      const env = envelopeFromCapture(head, messages.length, 0, false);
      env.length = size;
      env.file = file;
      messages.push(env);
    } finally {
      await fh.close();
    }
  }
  return { kind: "eml", path, messages };
}

// ---------------------------------------------------------------------------
// Envelope filtering (pure — used by the search tool)

export interface FilterOptions {
  query?: string;
  from?: string;
  subject?: string;
  afterTs?: number;
  beforeTs?: number;
}

export function filterMessages(messages: Envelope[], opts: FilterOptions): Envelope[] {
  const q = opts.query?.toLowerCase();
  const f = opts.from?.toLowerCase();
  const s = opts.subject?.toLowerCase();
  return messages.filter((m) => {
    if (q && !`${m.from ?? ""} ${m.subject ?? ""}`.toLowerCase().includes(q)) return false;
    if (f && !(m.from ?? "").toLowerCase().includes(f)) return false;
    if (s && !(m.subject ?? "").toLowerCase().includes(s)) return false;
    if (opts.afterTs !== undefined && (m.timestamp === undefined || m.timestamp < opts.afterTs)) return false;
    if (opts.beforeTs !== undefined && (m.timestamp === undefined || m.timestamp > opts.beforeTs)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Public entry with staleness-aware cache

const cache = new Map<string, { size: number; mtimeMs: number; index: ArchiveIndex }>();

export async function openArchive(rawPath: string): Promise<ArchiveIndex> {
  const path = resolve(rawPath);
  const s = await stat(path).catch(() => {
    throw new Error(`Path not found: ${path}`);
  });
  const hit = cache.get(path);
  if (hit && hit.size === s.size && hit.mtimeMs === s.mtimeMs) return hit.index;

  const index = s.isDirectory() ? await indexEmlDir(path) : await indexMbox(path);
  cache.set(path, { size: s.size, mtimeMs: s.mtimeMs, index });
  return index;
}
