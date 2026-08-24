/**
 * Header decoding and the mail rules, without a server.
 *
 * The decoding tests are the ones with teeth. "Rules by sender and subject" is only as good as the
 * subject, and a German mailbox produces three spellings of the same word: the legal encoded word,
 * raw UTF-8 that no header may contain but every client sends, and raw ISO-8859-1 from something
 * older. A rule that matches only the first of the three is a rule that silently stops working.
 */
import { describe, expect, it } from 'vitest';

import {
  addressList,
  addressOf,
  decodeHeaderBytes,
  headerValue,
  mailRuleMatches,
  matchingMailRules,
  parseHeaderBlock,
  skippedBy,
  toIngestRules,
} from '../src/index.js';
import type { MailEnvelope, MailRule } from '../src/index.js';

const block = (lines: readonly string[], charset: BufferEncoding = 'utf8'): Buffer =>
  Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, charset);

describe('parseHeaderBlock', () => {
  it('decodes an RFC 2047 encoded word in ISO-8859-1', () => {
    const headers = parseHeaderBlock(block(['Subject: =?ISO-8859-1?Q?R=FCckfrage_zur_Rechnung?=']));
    expect(headerValue(headers, 'subject')).toBe('Rückfrage zur Rechnung');
  });

  it('decodes a base64 encoded word in UTF-8', () => {
    const encoded = Buffer.from('Grüße aus Ulm', 'utf8').toString('base64');
    const headers = parseHeaderBlock(block([`Subject: =?UTF-8?B?${encoded}?=`]));
    expect(headerValue(headers, 'subject')).toBe('Grüße aus Ulm');
  });

  it('reads raw undeclared UTF-8, which is illegal and ubiquitous', () => {
    const headers = parseHeaderBlock(block(['Subject: Grundsteuerbescheid für Ulm']));
    expect(headerValue(headers, 'subject')).toBe('Grundsteuerbescheid für Ulm');
  });

  it('falls back to ISO-8859-1 for a block that is not valid UTF-8', () => {
    const headers = parseHeaderBlock(block(['Subject: Grundsteuerbescheid für Ulm'], 'latin1'));
    expect(headerValue(headers, 'subject')).toBe('Grundsteuerbescheid für Ulm');
  });

  it('never produces a replacement character, because a mojibake subject is still matchable', () => {
    const decoded = decodeHeaderBytes(Buffer.from([0x53, 0x3a, 0x20, 0xff, 0xfe, 0xfd]));
    expect(decoded).not.toContain('�');
  });

  it('unfolds a continuation line', () => {
    const headers = parseHeaderBlock(
      block(['Subject: a subject that runs', ' onto a second line', 'From: a@example.org']),
    );
    expect(headerValue(headers, 'subject')).toBe('a subject that runs onto a second line');
    expect(headerValue(headers, 'from')).toBe('a@example.org');
  });

  it('keeps every value of a repeated header', () => {
    const headers = parseHeaderBlock(block(['Received: from one', 'Received: from two']));
    expect(headers['received']).toEqual(['from one', 'from two']);
  });
});

describe('addressOf', () => {
  it('takes the address out of a display-name form, lower-cased', () => {
    expect(addressOf('"Dr Ada Lovelace" <Ada@Example.ORG>')).toBe('ada@example.org');
    expect(addressOf('bare@example.org')).toBe('bare@example.org');
    expect(addressOf(null)).toBeNull();
  });

  it('splits a recipient list', () => {
    expect(addressList('A <a@example.org>, b@example.org')).toEqual(['a@example.org', 'b@example.org']);
  });
});

describe('mail rules', () => {
  const envelope: MailEnvelope = {
    from: 'Stadtwerke Ulm <billing@stadtwerke.example>',
    subject: 'Ihre Rechnung R-77',
    recipients: ['post@example.org'],
  };

  const rules: MailRule[] = [
    { id: 'newsletter', match: { from: 'news@' }, actions: { skip: true } },
    {
      id: 'utilities',
      priority: 10,
      match: { from: 'stadtwerke\\.example', subject: 'Rechnung' },
      actions: { addTags: ['utilities'], itemType: 'invoice' },
    },
    { id: 'everything', match: {}, actions: { addTags: ['mail'] } },
  ];

  it('matches every clause or none, and is case-insensitive by default', () => {
    expect(mailRuleMatches(rules[1]!, envelope)).toBe(true);
    expect(mailRuleMatches(rules[1]!, { ...envelope, subject: 'Mahnung' })).toBe(false);
    expect(mailRuleMatches(rules[1]!, { ...envelope, subject: 'IHRE RECHNUNG' })).toBe(true);
  });

  it('reports the matching rules in evaluation order, highest priority first', () => {
    expect(matchingMailRules(rules, envelope).map((rule) => rule.id)).toEqual(['utilities', 'everything']);
  });

  it('names the rule that skips a message, and skips nothing else', () => {
    expect(skippedBy(rules, envelope)).toBeNull();
    expect(skippedBy(rules, { ...envelope, from: 'news@shop.example' })?.id).toBe('newsletter');
  });

  it('compiles filing rules for the pipeline and leaves the skip rules behind', () => {
    const compiled = toIngestRules('imap://rh@host/INBOX', rules);

    expect(compiled.map((rule) => rule.id)).toEqual([
      'mail:imap://rh@host/INBOX:utilities',
      'mail:imap://rh@host/INBOX:everything',
    ]);
    // Every compiled rule is pinned to its own source, so a mail rule cannot fire on a document
    // that came out of a watched folder in the same run.
    expect(compiled.every((rule) => rule.match.sourceId?.[0] === 'imap://rh@host/INBOX')).toBe(true);
    expect(compiled[0]?.match.sender).toEqual({ pattern: 'stadtwerke\\.example', flags: 'i' });
    expect(compiled[0]?.match.subject).toEqual({ pattern: 'Rechnung', flags: 'i' });
    expect(compiled[0]?.actions.addTags).toEqual(['utilities']);
    expect(compiled[0]?.actions.itemType).toBe('invoice');
  });

  it('honours a pattern given as data, flags and all', () => {
    const rule: MailRule = {
      id: 'exact',
      match: { subject: { pattern: '^Rechnung$', flags: '' } },
      actions: { addTags: ['exact'] },
    };
    expect(mailRuleMatches(rule, { ...envelope, subject: 'Rechnung' })).toBe(true);
    expect(mailRuleMatches(rule, { ...envelope, subject: 'rechnung' })).toBe(false);
  });
});
