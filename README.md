# mbox-mcp

An [MCP](https://modelcontextprotocol.io) server for **local email archives**. Point it at a Google Takeout `.mbox` export or a folder of `.eml` files and ask Claude things like:

- *"Who did I email most in this archive?"*
- *"Find the message where the landlord mentioned the lease renewal."*
- *"Summarize my correspondence with bob@example.com from early 2026."*

**Everything stays on your machine.** No OAuth, no app passwords, no IMAP connection, no cloud. Every other email MCP server connects to a live account — this one reads the archive files you already have, which is exactly what you want for the 15 years of Gmail sitting in a Takeout export.

## Quick start

**Claude Code**

```bash
claude mcp add mbox -- npx -y mbox-mcp
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mbox": {
      "command": "npx",
      "args": ["-y", "mbox-mcp"]
    }
  }
}
```

Then: *"Open C:\\Takeout\\Mail\\All mail Including Spam and Trash.mbox and tell me about it."*

## Tools

| Tool | What it does |
|------|--------------|
| `open_archive` | Index an .mbox file or .eml directory: message count, date range, top senders |
| `search_messages` | Search by keyword, sender, subject, date range — plus bounded body-text search |
| `get_message` | Fully parse one message: decoded body, headers, attachment names/sizes |

## Built for large archives

A Takeout mbox is often multiple gigabytes with 100k+ messages. The design reads the minimum, lazily:

- **Streaming index** — one pass in 8 MiB chunks, recording byte offsets; only the current message's first 16 KiB is ever held for envelope parsing (sender, subject, date, RFC 2047 decoding).
- **Full MIME on demand** — reading a message parses just that message ([postal-mime](https://github.com/postalsys/postal-mime): nested multipart, charsets, quoted-printable/base64). Attachments are listed with names and sizes, never dumped into context.
- **Honest body search** — `body_query` only full-parses messages that already match your envelope filters, stops at a scan cap, and reports how many it scanned, so the model knows to narrow by sender or date first.
- **Staleness-aware cache** — archives are indexed once per process and re-indexed if the file changes.

## Notes and limitations

- mbox variants: Takeout and Thunderbird produce `mboxrd` (body `From ` lines are quoted as `>From `), which splits cleanly. Plain `mboxo` archives with unquoted body `From ` lines can over-split.
- Attachment *contents* are never returned or written anywhere.
- PST/OST and Maildir are out of scope for now.

## Development

```bash
npm install
npm test                 # offline tests — synthetic archives built in-suite
npm run build            # tsc → dist/
node scripts/smoke.mjs   # end-to-end: generates an archive, drives the server over stdio
```

Architecture: [`src/archive.ts`](src/archive.ts) (streaming indexer, header decoding, envelope filtering) and [`src/reader.ts`](src/reader.ts) (per-message MIME parsing) are pure logic; [`src/index.ts`](src/index.ts) is the MCP wiring. The test suite includes a chunk-seam property test: indexing with pathological 17-byte chunks must produce an identical index to whole-file reads.

## License

MIT
