// Self-contained smoke test: generates a synthetic mbox in a temp dir, then
// drives the built server over stdio. No real email involved.
// Usage: npm run build && node scripts/smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const msg = (n, from, subject, body, date) =>
  [
    `From ${from} Thu Jan 0${n} 10:00:00 2026`,
    `From: ${from}`,
    "To: kole@example.com",
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: <${n}@example.com>`,
    "",
    body,
    "",
  ].join("\n");

const mbox = [
  msg(1, "alice@example.com", "Lease renewal", "The lease renewal is attached. Rent stays at 1800.", "Thu, 15 Jan 2026 10:00:00 +0000"),
  msg(2, "bob@example.com", "Coffee?", "Free Thursday for a coffee downtown?", "Fri, 20 Feb 2026 12:30:00 +0000"),
  msg(3, "alice@example.com", "Re: Lease renewal", "Signed copy received, thanks!", "Sat, 21 Mar 2026 09:15:00 +0000"),
].join("\n");

const dir = await mkdtemp(join(tmpdir(), "mbox-mcp-smoke-"));
const path = join(dir, "test.mbox");
await writeFile(path, mbox);

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] }));

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const calls = [
  ["open_archive", { path }],
  ["search_messages", { path, from: "alice" }],
  ["search_messages", { path, body_query: "signed copy" }],
  ["get_message", { path, id: 0 }],
  ["get_message", { path, id: 99 }], // must be isError
];

for (const [name, args] of calls) {
  const res = await client.callTool({ name, arguments: args });
  console.log(`\n== ${name} ${res.isError ? "(isError)" : ""}\n${res.content[0].text.slice(0, 450)}`);
}

await client.close();
await rm(dir, { recursive: true, force: true });
console.log("\nSMOKE OK");
