# mbox-mcp — Design

**Date:** 2026-08-14
**Goal:** Fourth portfolio MCP server.

## Idea selection

Checked and eliminated first: MCP meta-testing tools (mcplint, mcp-validation,
mcp-server-fuzzer, mcp-testing-framework all exist).

**Chosen: local email-archive search (mbox + eml).** Every existing email MCP
server is a *live-account* integration — Gmail API, IMAP/SMTP, OAuth tokens.
Nothing serves the archive files people actually have on disk: Google Takeout
`.mbox` exports, Thunderbird folders, `.eml` files. The gap is also the pitch:
**your 15 years of email never leaves your machine.** No OAuth, no app
passwords, no cloud.

## The engineering problem

A Takeout mbox is often multiple GB with 100k+ messages. The design mirrors
gguf-mcp's discipline — read the minimum, lazily:

- **Streaming index.** The file is scanned once in 8 MiB chunks, splitting on
  mbox `From ` separator lines and recording each message's byte offset and
  length. Nothing is retained but the index.
- **Light envelope parse at index time.** Only the header block of each
  message is decoded (date, from, to, subject, message-id), with hand-rolled
  header unfolding and RFC 2047 encoded-word decoding (B/Q, charset via
  TextDecoder). Full MIME parsing at index time would be 100× the work for
  data nobody asked for yet.
- **Full parse on demand.** `get_message` reads one message's bytes by offset
  and hands them to `postal-mime` (small, zero-dep, correct MIME: nested
  multipart, charsets, attachments). Attachments are listed (name/type/size),
  never dumped into context.
- **Cache with staleness check.** Indexes are memoized per path and rebuilt
  if file size/mtime changes.

## Tools

| Tool | Purpose |
|------|---------|
| `open_archive(path)` | Index an .mbox file or a directory of .eml files; returns count, date range, size, top senders |
| `search_messages(path, query?, from?, subject?, after?, before?, body_query?, limit?)` | Envelope search over the index; optional bounded body search (full-parses candidates, capped, reports how many were scanned) |
| `get_message(path, id)` | One message, fully parsed: headers, text body (truncated if huge), attachment list |

Body search is honest about its cost: it only full-parses messages that
already match the envelope filters, stops at a scan cap, and reports
`scanned`/`capped` so the model knows to narrow with sender/date filters.

## Formats and limitations

- mbox variants: Takeout produces mboxrd (`>From ` quoting in bodies), which
  splits cleanly on `/^From /`. Plain mboxo archives with unquoted body
  `From ` lines can over-split; documented limitation.
- CRLF and LF archives both handled.
- `.eml` directories: each file is one message, same envelope index.

## Testing

Synthetic archives built in-suite (multipart message, RFC 2047-encoded
subject, quoted-printable body, CRLF and LF variants) — no fixtures, no real
email. Smoke test generates an archive in a temp dir and drives the built
server over stdio.

## Out of scope (v1)

Attachment extraction to disk, write operations of any kind, PST/OST
(proprietary), Maildir, full-text indexing to disk (SQLite/FTS — the roadmap
item if body search proves too slow on huge archives).
