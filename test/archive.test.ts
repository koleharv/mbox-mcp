import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeWords, filterMessages, indexMbox, openArchive, parseHeaders } from "../src/archive.js";
import { bodyMatches, parseMessage } from "../src/reader.js";
import { buildMbox, MSG_PLAIN } from "./fixtures.js";

let dir: string;
let mboxPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mbox-mcp-test-"));
  mboxPath = join(dir, "archive.mbox");
  await writeFile(mboxPath, buildMbox());
});

afterAll(() => rm(dir, { recursive: true, force: true }));

describe("decodeWords", () => {
  it("decodes B and Q encoded words", () => {
    expect(decodeWords("=?utf-8?B?Qm9iIMOJY3J1?=")).toBe("Bob Écru");
    expect(decodeWords("=?iso-8859-1?Q?Caf=E9_time?=")).toBe("Café time");
  });

  it("joins adjacent encoded words and leaves unknown charsets raw", () => {
    expect(decodeWords("=?utf-8?B?UsOp?= =?utf-8?B?c3Vtw6k=?=")).toBe("Résumé");
    expect(decodeWords("=?x-martian?B?UsOp?=")).toBe("=?x-martian?B?UsOp?=");
  });
});

describe("parseHeaders", () => {
  it("unfolds continuation lines and lowercases names", () => {
    const h = parseHeaders("Subject: one\r\n two\r\nFROM: a@b.c");
    expect(h.get("subject")).toBe("one two");
    expect(h.get("from")).toBe("a@b.c");
  });
});

describe("indexMbox", () => {
  it("splits messages and parses envelopes", async () => {
    const index = await indexMbox(mboxPath);
    expect(index.messages).toHaveLength(3);
    const [plain, encoded, multi] = index.messages;
    expect(plain.from).toBe("Alice Example <alice@example.com>");
    expect(plain.subject).toBe("Lease renewal");
    expect(plain.date).toBe("2026-01-15T10:00:00.000Z");
    expect(encoded.from).toBe("Bob Écru <bob@example.com>");
    expect(encoded.subject).toBe("Résumé ☕");
    expect(multi.subject).toBe("Quarterly report attached");
    // offsets/lengths tile the file exactly
    expect(plain.offset).toBe(0);
    expect(encoded.offset).toBe(plain.length);
    expect(multi.offset + multi.length).toBe(Buffer.byteLength(buildMbox()));
  });

  it("does not split on mboxrd-quoted body lines", async () => {
    const index = await indexMbox(mboxPath);
    expect(index.messages).toHaveLength(3); // ">From my side" must not create a 4th
  });

  it("produces an identical index with tiny chunks (seam robustness)", async () => {
    const whole = await indexMbox(mboxPath);
    for (const chunkSize of [17, 32, 64]) {
      const chunked = await indexMbox(mboxPath, chunkSize);
      expect(chunked.messages).toEqual(whole.messages);
    }
  });

  it("rejects non-mbox files", async () => {
    const bad = join(dir, "notmail.mbox");
    await writeFile(bad, "hello world");
    await expect(indexMbox(bad)).rejects.toThrow(/does not start with an mbox/);
  });
});

describe("openArchive", () => {
  it("indexes .eml directories", async () => {
    const emlDir = join(dir, "eml");
    await writeFile(join(dir, "placeholder"), ""); // ensure dir var stays a file-free zone
    const { mkdir } = await import("node:fs/promises");
    await mkdir(emlDir, { recursive: true });
    await writeFile(join(emlDir, "a.eml"), "From: x@y.z\nSubject: First\nDate: Mon, 02 Feb 2026 08:00:00 +0000\n\nBody A\n");
    await writeFile(join(emlDir, "b.eml"), "From: q@y.z\nSubject: Second\nDate: Tue, 03 Feb 2026 08:00:00 +0000\n\nBody B\n");
    const index = await openArchive(emlDir);
    expect(index.kind).toBe("eml");
    expect(index.messages.map((m) => m.subject)).toEqual(["First", "Second"]);
  });

  it("re-indexes when the file changes", async () => {
    const growing = join(dir, "growing.mbox");
    await writeFile(growing, MSG_PLAIN);
    expect((await openArchive(growing)).messages).toHaveLength(1);
    await appendFile(growing, `\n${MSG_PLAIN}`);
    expect((await openArchive(growing)).messages).toHaveLength(2);
  });
});

describe("filterMessages", () => {
  it("filters by query, sender, and date range", async () => {
    const { messages } = await indexMbox(mboxPath);
    expect(filterMessages(messages, { query: "lease" }).map((m) => m.id)).toEqual([0]);
    expect(filterMessages(messages, { from: "bob@" }).map((m) => m.id)).toEqual([1]);
    expect(
      filterMessages(messages, { afterTs: Date.parse("2026-02-01"), beforeTs: Date.parse("2026-03-01") }).map((m) => m.id),
    ).toEqual([1]);
  });
});

describe("reader", () => {
  it("fully parses a message: decoded body and attachment list", async () => {
    const index = await indexMbox(mboxPath);
    const multi = await parseMessage(index, index.messages[2]);
    expect(multi.body).toContain("projections mention gasoline");
    expect(multi.attachments).toEqual([{ filename: "report.pdf", mimeType: "application/pdf", size: 26 }]);

    const encoded = await parseMessage(index, index.messages[1]);
    expect(encoded.body).toContain("Café meeting confirmed —");
    expect(encoded.subject).toBe("Résumé ☕");
  });

  it("matches body text for bounded body search", async () => {
    const index = await indexMbox(mboxPath);
    expect(await bodyMatches(index, index.messages[2], "GASOLINE")).toBe(true);
    expect(await bodyMatches(index, index.messages[0], "gasoline")).toBe(false);
  });
});
