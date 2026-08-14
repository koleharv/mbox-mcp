#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { filterMessages, openArchive, type Envelope } from "./archive.js";
import { bodyMatches, parseMessage } from "./reader.js";

const server = new McpServer({ name: "mbox", version: "0.1.0" });
const BODY_SCAN_CAP = 500; // body search full-parses candidates; keep it bounded

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function guarded<A extends unknown[]>(fn: (...args: A) => Promise<ToolResult>) {
  return async (...args: A): Promise<ToolResult> => {
    try {
      return await fn(...args);
    } catch (err) {
      return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  };
}

const pathArg = z.string().describe("Path to an .mbox file (e.g. a Google Takeout export) or a directory of .eml files");

function briefOf(env: Envelope) {
  return { id: env.id, date: env.date, from: env.from, subject: env.subject };
}

server.registerTool(
  "open_archive",
  {
    title: "Open a local email archive",
    description:
      "Index an .mbox file (Google Takeout, Thunderbird) or a directory of .eml files — entirely locally, nothing leaves the machine. Returns message count, date range, and top senders. Large archives are indexed once and cached.",
    inputSchema: { path: pathArg },
  },
  guarded(async ({ path }) => {
    const index = await openArchive(path);
    const stamps = index.messages.map((m) => m.timestamp).filter((t): t is number => t !== undefined);
    const senders = new Map<string, number>();
    for (const m of index.messages) {
      if (m.from) senders.set(m.from, (senders.get(m.from) ?? 0) + 1);
    }
    const topSenders = [...senders.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([from, count]) => ({ from, count }));
    return jsonResult({
      kind: index.kind,
      messageCount: index.messages.length,
      earliest: stamps.length ? new Date(Math.min(...stamps)).toISOString() : undefined,
      latest: stamps.length ? new Date(Math.max(...stamps)).toISOString() : undefined,
      topSenders,
    });
  }),
);

server.registerTool(
  "search_messages",
  {
    title: "Search the archive",
    description:
      "Search indexed envelopes (from/to/subject/date). `query` matches sender and subject. `body_query` additionally full-parses candidate messages to search body text — it is capped, so narrow with sender/date filters first; the result reports how many candidates were scanned.",
    inputSchema: {
      path: pathArg,
      query: z.string().optional().describe("Keyword matched against sender and subject"),
      from: z.string().optional().describe("Substring of the sender"),
      subject: z.string().optional().describe("Substring of the subject"),
      after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only messages on/after this date, YYYY-MM-DD"),
      before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only messages on/before this date, YYYY-MM-DD"),
      body_query: z.string().optional().describe("Substring searched in message bodies (bounded scan)"),
      limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
    },
  },
  guarded(async ({ path, query, from, subject, after, before, body_query, limit }) => {
    const index = await openArchive(path);
    let candidates = filterMessages(index.messages, {
      query,
      from,
      subject,
      afterTs: after ? Date.parse(after) : undefined,
      beforeTs: before ? Date.parse(before) + 86_399_999 : undefined,
    });

    let scanned: number | undefined;
    let capped = false;
    if (body_query) {
      const toScan = candidates.slice(0, BODY_SCAN_CAP);
      capped = candidates.length > BODY_SCAN_CAP;
      scanned = toScan.length;
      const matched: Envelope[] = [];
      for (const env of toScan) {
        if (await bodyMatches(index, env, body_query)) matched.push(env);
      }
      candidates = matched;
    }

    const results = candidates
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
      .slice(0, limit)
      .map(briefOf);
    return jsonResult({
      totalMatches: candidates.length,
      showing: results.length,
      ...(scanned !== undefined ? { bodiesScanned: scanned, scanCapped: capped } : {}),
      results,
    });
  }),
);

server.registerTool(
  "get_message",
  {
    title: "Read a message",
    description:
      "Fully parse one message by its id (from search_messages): headers, decoded text body (truncated if huge), and attachment names/types/sizes. Attachment contents are never returned.",
    inputSchema: {
      path: pathArg,
      id: z.number().int().min(0).describe("Message id from search results"),
    },
  },
  guarded(async ({ path, id }) => {
    const index = await openArchive(path);
    const env = index.messages[id];
    if (!env) throw new Error(`No message with id ${id} (archive has ${index.messages.length} messages, ids 0-${index.messages.length - 1})`);
    return jsonResult(await parseMessage(index, env));
  }),
);

await server.connect(new StdioServerTransport());
