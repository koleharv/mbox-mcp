// Synthetic three-message mbox: plain text, RFC 2047 + quoted-printable, multipart.

export const MSG_PLAIN = [
  "From alice@example.com Thu Jan 15 10:00:00 2026",
  "From: Alice Example <alice@example.com>",
  "To: kole@example.com",
  "Subject: Lease renewal",
  "Date: Thu, 15 Jan 2026 10:00:00 +0000",
  "Message-ID: <plain-1@example.com>",
  "",
  "Hi Kole,",
  ">From my side the lease terms look fine.", // mboxrd-quoted body From line
  "Rent stays at 1800.",
  "",
].join("\n");

// Subject: "Résumé ☕" (B-encoded utf-8), quoted-printable body, CRLF line endings
export const MSG_ENCODED = [
  "From bob@example.com Fri Feb 20 12:30:00 2026",
  "From: =?utf-8?B?Qm9iIMOJY3J1?= <bob@example.com>",
  "To: kole@example.com",
  "Subject: =?utf-8?B?UsOpc3Vtw6kg4piV?=",
  "Date: Fri, 20 Feb 2026 12:30:00 +0000",
  "Message-ID: <enc-2@example.com>",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Caf=C3=A9 meeting confirmed =E2=80=94 see you there.",
  "",
].join("\r\n");

export const MSG_MULTIPART = [
  "From carol@example.com Sat Mar 21 09:15:00 2026",
  "From: carol@example.com",
  "To: kole@example.com",
  "Subject: Quarterly report attached",
  "Date: Sat, 21 Mar 2026 09:15:00 +0000",
  "Message-ID: <multi-3@example.com>",
  'Content-Type: multipart/mixed; boundary="XYZ"',
  "",
  "--XYZ",
  "Content-Type: text/plain",
  "",
  "Report attached. The projections mention gasoline costs.",
  "--XYZ",
  'Content-Type: application/pdf; name="report.pdf"',
  'Content-Disposition: attachment; filename="report.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("fake pdf bytes for testing").toString("base64"),
  "--XYZ--",
  "",
].join("\n");

export function buildMbox(): string {
  return [MSG_PLAIN, MSG_ENCODED, MSG_MULTIPART].join("\n");
}
