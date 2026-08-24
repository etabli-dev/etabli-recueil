/*
 * Recueil — fixtures
 * Copyright (C) 2026 the Recueil authors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * `fixtures/mail/` — the corpus for the IMAP source in CONCEPT §5.3: "attachments as Documents, body
 * as Note, rules by sender/subject".
 *
 * Eight messages, each one a different way for that sentence to go wrong.
 *
 *   - Which part *is* the body, when there are two of them and one is HTML.
 *   - Which parts are attachments, when one of them is an inline image the HTML refers to by
 *     `cid:` and is not an attachment at all.
 *   - What the attachment is called, when the name arrives in `filename=`, in `name=`, split across
 *     RFC 2231 continuations, or not at all — and when the name is `../../../../etc/cron.d/…`.
 *   - What the Subject says, when it is not UTF-8. `subject-non-utf8.eml` is not a valid UTF-8 file
 *     and must not be read as one; a `readFileSync(path, 'utf8')` anywhere in the mail path turns
 *     its Subject into replacement characters and its body into mojibake.
 *   - What a nested `message/rfc822` contains, and whether its own attachment is reached.
 *   - What happens when the boundary is wrong. `malformed-boundary.eml` must be *handled*: the
 *     parts that can be recovered are recovered, the remainder is reported, and nothing throws.
 *
 * Two of the attachments are byte-identical to files that arrive by other routes (see
 * `assets.mjs`), so the exact-duplicate check at stage 2 has something to catch.
 *
 * Every file is CRLF, as a `.eml` must be.
 */
import {
  CRLF,
  base64Lines,
  encodeCharset,
  encodedWord,
  message,
  multipart,
  part,
  quotedPrintable,
} from './mime.mjs';

const TO = 'Archiv Recueil <archiv@recueil.invalid>';

/**
 * @param {object} shared
 * @param {Buffer} shared.invoicePdf   the same bytes as `scans/invoice-image-only.pdf`
 * @param {Buffer} shared.minutesPdf
 * @param {Buffer} shared.contractPdf
 * @param {Buffer} shared.receiptPng
 * @param {Buffer} shared.logoPng
 * @returns {Array<{ path: string, bytes: Buffer, note: string }>}
 */
export function buildMail({ invoicePdf, minutesPdf, contractPdf, receiptPng, logoPng }) {
  /** @type {Array<{ path: string, bytes: Buffer, note: string }>} */
  const files = [];
  const add = (path, bytes, note) => files.push({ path, bytes, note });

  /* -- 1. plain text ------------------------------------------------------------------------ */

  add(
    'mail/plain-text.eml',
    message(
      [
        ['Return-Path', '<anna.weiss@example.org>'],
        [
          'Received',
          'from mail.example.org (mail.example.org [203.0.113.24]) by mx.recueil.invalid ' +
            'with ESMTPS id 4Pk9Zt2yQzz3rT for <archiv@recueil.invalid>; ' +
            'Tue, 14 Mar 2023 09:12:07 +0100 (CET)',
        ],
        ['Date', 'Tue, 14 Mar 2023 09:12:04 +0100'],
        ['From', `${encodedWord('Anna Weiß', 'utf-8')} <anna.weiss@example.org>`],
        ['To', TO],
        ['Subject', encodedWord('Kurze Rückmeldung zur Messreihe Sigmaringen', 'utf-8')],
        ['Message-ID', '<20230314081204.4a1c9e7b@mail.example.org>'],
        ['MIME-Version', '1.0'],
        ['Content-Type', 'text/plain; charset=utf-8; format=flowed'],
        ['Content-Transfer-Encoding', 'quoted-printable'],
      ],
      quotedPrintable(
        Buffer.from(
          [
            'Liebe Kolleginnen und Kollegen,',
            '',
            'die Überschreitung im Juli 2022 an der Messstelle Sigmaringen ist',
            'inzwischen geklärt: der Trübungssensor war während des',
            'Niedrigwassers zeitweise nicht überströmt. Die Werte für den',
            'Zeitraum 12.07. bis 26.07. sind entsprechend zu kennzeichnen.',
            '',
            'Viele Grüße',
            'Anna Weiß',
            '',
            '-- ',
            'Dr. Anna Weiß · Landesanstalt für Umwelt',
            '',
          ].join('\n'),
          'utf8',
        ),
      ),
    ),
    'one part, text/plain, UTF-8 quoted-printable: the body is a Note and there is nothing else',
  );

  /* -- 2. HTML multipart -------------------------------------------------------------------- */

  const altBoundary = '------------7Yh2Kc9Qm4Tz0Ln5';
  add(
    'mail/html-multipart.eml',
    message(
      [
        ['Date', 'Thu, 08 Jun 2023 17:44:31 +0200'],
        ['From', 'Newsletter Wasserwirtschaft <newsletter@example.net>'],
        ['To', TO],
        ['Reply-To', 'noreply@example.net'],
        ['Subject', 'Ausgabe 6/2023: Niedrigwasser und Grundwasserneubildung'],
        ['Message-ID', '<0f1a2b3c4d5e6f70.newsletter@example.net>'],
        ['List-Id', 'Wasserwirtschaft Newsletter <newsletter.example.net>'],
        ['List-Unsubscribe', '<mailto:unsubscribe@example.net?subject=6%2F2023>'],
        ['MIME-Version', '1.0'],
        ['Content-Type', `multipart/alternative; boundary="${altBoundary}"`],
      ],
      multipart(altBoundary, [
        part(
          [
            ['Content-Type', 'text/plain; charset=utf-8'],
            ['Content-Transfer-Encoding', 'quoted-printable'],
          ],
          quotedPrintable(
            Buffer.from(
              [
                'AUSGABE 6/2023',
                '',
                'Niedrigwasser und Grundwasserneubildung',
                'https://example.net/ausgaben/2023-06?utm_source=mail&utm_medium=e-mail',
                '',
                'Abmelden: https://example.net/abmelden',
                '',
              ].join('\n'),
              'utf8',
            ),
          ),
        ),
        part(
          [
            ['Content-Type', 'text/html; charset=utf-8'],
            ['Content-Transfer-Encoding', 'quoted-printable'],
          ],
          quotedPrintable(
            Buffer.from(
              [
                '<!DOCTYPE html>',
                '<html lang="de"><head><meta charset="utf-8"></head><body>',
                '<h1>Ausgabe 6/2023</h1>',
                '<p>Niedrigwasser &amp; Grundwasserneubildung &mdash; ein &Uuml;berblick.</p>',
                '<p><a href="https://example.net/ausgaben/2023-06?utm_source=mail&amp;utm_medium=e-mail">',
                'Zur Ausgabe</a></p>',
                '<p style="font-size:11px;color:#777">',
                '<a href="https://example.net/abmelden">Abmelden</a></p>',
                '</body></html>',
                '',
              ].join('\n'),
              'utf8',
            ),
          ),
        ),
      ]),
    ),
    'multipart/alternative: two representations of one body, and only one of them is the Note',
  );

  /* -- 3. two attachments ------------------------------------------------------------------- */

  const mixedBoundary = '=_9c1f4d2e8b7a406f9d3e1c05a7b28f41';
  add(
    'mail/two-attachments.eml',
    message(
      [
        ['Date', 'Tue, 14 Mar 2023 11:02:56 +0100'],
        ['From', 'Buchhaltung Stadtwerke Ulm <rechnung@stadtwerke-ulm.example>'],
        ['To', TO],
        ['Subject', 'Ihre Rechnung 2023-004417 und das Sitzungsprotokoll'],
        ['Message-ID', '<swu-2023-004417.11025601@stadtwerke-ulm.example>'],
        ['MIME-Version', '1.0'],
        ['Content-Type', `multipart/mixed; boundary="${mixedBoundary}"`],
      ],
      multipart(mixedBoundary, [
        part(
          [
            ['Content-Type', 'text/plain; charset=utf-8'],
            ['Content-Transfer-Encoding', '8bit'],
          ],
          Buffer.from(
            [
              'Sehr geehrte Damen und Herren,',
              '',
              'anbei die Rechnung 2023-004417 sowie das Protokoll der Sitzung',
              'vom 13. März 2023.',
              '',
              'Mit freundlichen Grüßen',
              'Buchhaltung',
              '',
            ].join(CRLF),
            'utf8',
          ),
        ),
        part(
          [
            ['Content-Type', 'application/pdf; name="Rechnung_2023-004417.pdf"'],
            ['Content-Description', 'Rechnung 2023-004417'],
            [
              'Content-Disposition',
              'attachment; filename="Rechnung_2023-004417.pdf"; size=' + invoicePdf.length,
            ],
            ['Content-Transfer-Encoding', 'base64'],
          ],
          base64Lines(invoicePdf),
        ),
        part(
          [
            ['Content-Type', 'application/pdf'],
            /* RFC 2231: the name is split across continuations and percent-encoded. A parser that
               reads `filename=` only finds nothing here, and one that reads `filename*0*` only
               finds half a name. */
            [
              'Content-Disposition',
              "attachment; filename*0*=utf-8''Protokoll%20Sitzung%20; " +
                'filename*1*=13.%20M%C3%A4rz%202023; filename*2*=.pdf',
            ],
            ['Content-Transfer-Encoding', 'base64'],
          ],
          base64Lines(minutesPdf),
        ),
      ]),
    ),
    'two attachments; the PDF is byte-identical to scans/invoice-image-only.pdf, and the second ' +
      'filename arrives in three RFC 2231 continuations',
  );

  /* -- 4. inline image ---------------------------------------------------------------------- */

  const relatedBoundary = '=_related_5b3d9f0c1e2a48d7';
  add(
    'mail/inline-image.eml',
    message(
      [
        ['Date', 'Mon, 11 Sep 2023 08:20:15 +0200'],
        ['From', 'Buchhandlung Jastram <bestellung@jastram.example>'],
        ['To', TO],
        ['Subject', 'Ihre Bestellung 2023/0912'],
        ['Message-ID', '<jastram.2023-0912@jastram.example>'],
        ['MIME-Version', '1.0'],
        ['Content-Type', `multipart/related; type="text/html"; boundary="${relatedBoundary}"`],
      ],
      multipart(relatedBoundary, [
        part(
          [
            ['Content-Type', 'text/html; charset=utf-8'],
            ['Content-Transfer-Encoding', 'quoted-printable'],
          ],
          quotedPrintable(
            Buffer.from(
              [
                '<html><body>',
                '<p><img src="cid:logo.9f31@jastram.example" alt="Recueil" width="160" height="40"></p>',
                '<p>Guten Tag,</p>',
                '<p>vielen Dank für Ihre Bestellung. Der Beleg liegt bei.</p>',
                '</body></html>',
                '',
              ].join('\n'),
              'utf8',
            ),
          ),
        ),
        part(
          [
            ['Content-Type', 'image/png'],
            /* `inline` with a Content-ID the HTML refers to. This is not an attachment: counting it
               as one puts a wordmark in the library as a Document of its own. */
            ['Content-ID', '<logo.9f31@jastram.example>'],
            ['Content-Disposition', 'inline; filename="logo.png"'],
            ['Content-Transfer-Encoding', 'base64'],
          ],
          base64Lines(logoPng),
        ),
        part(
          [
            ['Content-Type', 'image/png; name="Beleg-2023-0912.png"'],
            ['Content-Disposition', 'attachment; filename="Beleg-2023-0912.png"'],
            ['Content-Transfer-Encoding', 'base64'],
          ],
          base64Lines(receiptPng),
        ),
      ]),
    ),
    'multipart/related: one inline cid: image that is not an attachment, and one that is',
  );

  /* -- 5. forwarded message with a nested .eml ---------------------------------------------- */

  const innerBoundary = '=_inner_7a4e2c81';
  const innerMessage = message(
    [
      ['Date', 'Fri, 21 Sep 2021 15:41:02 +0200'],
      ['From', 'Hausverwaltung Kessler <verwaltung@kessler.example>'],
      ['To', 'R. Heller <r.heller@example.org>'],
      ['Subject', 'Mietvertrag Lagerraum Nr. 14'],
      ['Message-ID', '<kessler.2021-09-21.1541@kessler.example>'],
      ['MIME-Version', '1.0'],
      ['Content-Type', `multipart/mixed; boundary="${innerBoundary}"`],
    ],
    multipart(innerBoundary, [
      part(
        [
          ['Content-Type', 'text/plain; charset=utf-8'],
          ['Content-Transfer-Encoding', '8bit'],
        ],
        Buffer.from(
          [
            'Guten Tag Herr Heller,',
            '',
            'anbei der unterschriebene Mietvertrag für den Lagerraum Nr. 14.',
            '',
            'Freundliche Grüße',
            'M. Kessler',
            '',
          ].join(CRLF),
          'utf8',
        ),
      ),
      part(
        [
          ['Content-Type', 'application/pdf; name="Mietvertrag-Lagerraum-14.pdf"'],
          ['Content-Disposition', 'attachment; filename="Mietvertrag-Lagerraum-14.pdf"'],
          ['Content-Transfer-Encoding', 'base64'],
        ],
        base64Lines(contractPdf),
      ),
    ]),
  );

  const outerBoundary = '=_forward_0d5b3819';
  add(
    'mail/forwarded-nested.eml',
    message(
      [
        ['Date', 'Wed, 04 Oct 2023 21:07:44 +0200'],
        ['From', 'R. Heller <r.heller@example.org>'],
        ['To', TO],
        ['Subject', 'Fwd: Mietvertrag Lagerraum Nr. 14'],
        ['References', '<kessler.2021-09-21.1541@kessler.example>'],
        ['Message-ID', '<fwd.20231004.210744@example.org>'],
        ['MIME-Version', '1.0'],
        ['Content-Type', `multipart/mixed; boundary="${outerBoundary}"`],
      ],
      multipart(outerBoundary, [
        part(
          [
            ['Content-Type', 'text/plain; charset=utf-8'],
            ['Content-Transfer-Encoding', '7bit'],
          ],
          Buffer.from(`Fuer das Archiv.${CRLF}${CRLF}`, 'ascii'),
        ),
        part(
          [
            ['Content-Type', 'message/rfc822'],
            /* A forwarded message is an attachment whose body is a whole message. The PDF inside it
               is two levels down; a walker that stops at `message/rfc822` never reaches it. */
            ['Content-Disposition', 'attachment; filename="Mietvertrag Lagerraum Nr. 14.eml"'],
            ['Content-Transfer-Encoding', '7bit'],
          ],
          innerMessage,
        ),
      ]),
    ),
    'a forwarded message/rfc822 whose own multipart body carries a PDF two levels down',
  );

  /* -- 6. non-UTF-8 Subject ----------------------------------------------------------------- */

  /* Three things at once, all of which happen in real mail:
       · a Q-encoded ISO-8859-15 word carrying a euro sign, whose byte (0xA4) means something else
         entirely in ISO-8859-1;
       · a second, adjacent encoded word, which RFC 2047 says is joined to the first with no space;
       · a raw 8-bit display name in `From`, which is illegal and which every German mail server has
         seen this week.
     The resulting file is not valid UTF-8. That is the point. */
  const subject =
    `${encodedWord('Zahlungserinnerung: 471,50 € offen ', 'iso-8859-15')} ` +
    `${encodedWord('(Kundennr. 88-201934)', 'iso-8859-15', 'B')}`;
  add(
    'mail/subject-non-utf8.eml',
    message(
      [
        ['Date', 'Tue, 04 Apr 2023 06:30:11 +0200'],
        [
          'From',
          `${encodeCharset('Buchhaltung Stadtwerke Ulm – Mahnwesen', 'windows-1252').toString(
            'latin1',
          )} <mahnung@stadtwerke-ulm.example>`,
        ],
        ['To', TO],
        ['Subject', subject],
        ['Message-ID', '<swu-mahnung-004417@stadtwerke-ulm.example>'],
        ['X-Mailer', 'Groupwise 8.0.3'],
        ['MIME-Version', '1.0'],
        ['Content-Type', 'text/plain; charset=ISO-8859-15'],
        ['Content-Transfer-Encoding', '8bit'],
      ],
      encodeCharset(
        [
          'Sehr geehrte Damen und Herren,',
          '',
          'zu unserer Rechnung 2023-004417 über 471,50 € konnten wir bislang',
          'keinen Zahlungseingang feststellen. Bitte überweisen Sie den',
          'Betrag bis zum 18.04.2023.',
          '',
          'Mit freundlichen Grüßen',
          'Buchhaltung Stadtwerke Ulm',
          '',
        ].join(CRLF),
        'iso-8859-15',
      ),
    ),
    'ISO-8859-15 Subject in two adjacent encoded words, a raw 8-bit display name, and an 8-bit ' +
      'body: the file is deliberately not valid UTF-8',
  );

  /* -- 7. malformed boundary ---------------------------------------------------------------- */

  /* Written as literal bytes, because no assembler would produce it. The declared boundary is
     unquoted and begins with two hyphens, so the delimiter line is four hyphens and the header is
     ambiguous to begin with; the second part's delimiter is two hyphens short and therefore reads
     as body text; and there is no closing delimiter at all, which is what a truncated IMAP fetch
     leaves behind. Recovering the first part and reporting the rest is the correct behaviour.
     Throwing is not. */
  add(
    'mail/malformed-boundary.eml',
    Buffer.from(
      [
        'Date: Thu, 26 Oct 2023 13:58:02 +0200',
        'From: Praxis Dr. Lindqvist <praxis@lindqvist.example>',
        'To: Archiv Recueil <archiv@recueil.invalid>',
        'Subject: Befund vom 26.10.2023',
        'Message-ID: <lindqvist.20231026.1358@lindqvist.example>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary=--=_Part_9182_1839',
        '',
        'This is a multi-part message in MIME format.',
        '----=_Part_9182_1839',
        'Content-Type: text/plain; charset=us-ascii',
        'Content-Transfer-Encoding: 7bit',
        '',
        'Guten Tag,',
        '',
        'anbei der Befund. Bitte um Rueckmeldung.',
        '',
        '--=_Part_9182_1839',
        'Content-Type: application/pdf; name="Befund.pdf"',
        'Content-Disposition: attachment; filename="Befund.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        'JVBERi0xLjQKJUNvcnJ1cHRlZCBhdHRhY2htZW50IC0gdGhlIGRlbGltaXRlciBhYm92ZSBp',
        'cyB0d28gaHlwaGVucyBzaG9ydCwgc28gdGhpcyBpcyBub3QgYSBwYXJ0LiBUaGVyZSBpcyBh',
        'bHNvIG5vIGNsb3NpbmcgZGVsaW1pdGVyLgo=',
        '',
      ].join(CRLF),
      'ascii',
    ),
    'an unquoted boundary starting with hyphens, a delimiter two characters short, and no closing ' +
      'delimiter: must be handled, never thrown on',
  );

  /* -- 8. hostile attachment names ---------------------------------------------------------- */

  const hostileBoundary = '=_hostile_3f8c1b42';
  add(
    'mail/attachment-name-traversal.eml',
    message(
      [
        ['Date', 'Sat, 18 Nov 2023 02:14:09 +0000'],
        ['From', 'invoices@billing-notice.example'],
        ['To', TO],
        ['Subject', 'Invoice 88201934 attached'],
        ['Message-ID', '<b1llin9.20231118.021409@billing-notice.example>'],
        ['MIME-Version', '1.0'],
        ['Content-Type', `multipart/mixed; boundary="${hostileBoundary}"`],
      ],
      multipart(hostileBoundary, [
        part(
          [
            ['Content-Type', 'text/plain; charset=us-ascii'],
            ['Content-Transfer-Encoding', '7bit'],
          ],
          Buffer.from(`Please find the invoice attached.${CRLF}${CRLF}`, 'ascii'),
        ),
        part(
          [
            ['Content-Type', 'application/pdf'],
            /* The obvious one. */
            [
              'Content-Disposition',
              'attachment; filename="../../../../etc/cron.d/recueil-pwn.pdf"',
            ],
            ['Content-Transfer-Encoding', 'base64'],
          ],
          base64Lines(Buffer.from('%PDF-1.4\n% traversal attempt, not a real document\n', 'ascii')),
        ),
        part(
          [
            /* A Windows absolute path with backslashes. `path.resolve` on Linux treats the whole
               thing as one filename; `path.win32` does not. Whichever the extractor uses, it must
               use it deliberately. */
            ['Content-Type', 'application/pdf; name="C:\\Windows\\Temp\\recueil-pwn.pdf"'],
            ['Content-Transfer-Encoding', 'base64'],
          ],
          base64Lines(Buffer.from('%PDF-1.4\n% windows path attempt\n', 'ascii')),
        ),
        part(
          [
            ['Content-Type', 'application/octet-stream'],
            /* Reassembled from RFC 2231 continuations, percent-decoded, it is `../../escape.pdf`.
               A check against the raw header value never sees it. */
            [
              'Content-Disposition',
              "attachment; filename*0*=utf-8''%2e%2e%2f; filename*1*=%2e%2e%2f; " +
                'filename*2*=escape.pdf',
            ],
            ['Content-Transfer-Encoding', 'base64'],
          ],
          base64Lines(Buffer.from('escape via RFC 2231 continuations\n', 'ascii')),
        ),
        part(
          [
            /* No disposition at all, a name that is only an extension, and a leading dot. */
            ['Content-Type', 'application/octet-stream; name=".bashrc"'],
            ['Content-Transfer-Encoding', 'base64'],
          ],
          base64Lines(Buffer.from('# not your shell profile\n', 'ascii')),
        ),
        part(
          [
            ['Content-Type', 'application/pdf; name="Invoice-88201934.pdf"'],
            ['Content-Disposition', 'attachment; filename="Invoice-88201934.pdf"'],
            ['Content-Transfer-Encoding', 'base64'],
          ],
          base64Lines(Buffer.from('%PDF-1.4\n% the one legitimate attachment\n', 'ascii')),
        ),
      ]),
    ),
    'five attachment names, four hostile and one legitimate: refusing the whole message is not the ' +
      'same as refusing the four',
  );

  return files;
}
