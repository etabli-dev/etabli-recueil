# Security policy

Recueil is a self-hosted server that holds someone's entire document library, so a security report
is welcome even when you are not sure it is a real finding. This document says what is supported,
how to report privately, what response to expect, and — as important — which properties Recueil
deliberately does **not** have in v1, so that time is not spent reporting them.

## Supported versions

The project is pre-1.0 and developed by one person (ADR-0014). There are no maintenance branches and
no backports.

| Version | Supported |
|---|---|
| `main` | Yes — fixes land here |
| Latest tagged `0.x` release | Yes, by superseding it with a new `0.x` release |
| Any earlier `0.x` release | No |

Upgrade guarantees begin at 1.0 (CONCEPT.md §7, Phase 9). Until then, "supported" means the fix goes
into `main` and the next release; it does not mean a patch for the version you are running.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a security problem.**

Use GitHub's private vulnerability reporting on this repository: the **Security** tab → **Report a
vulnerability**. That opens a private advisory visible only to you and the maintainer, and it is the
preferred channel because the fix, the CVE request and the disclosure all happen in one place.

If you cannot use that form, open a public issue that says only that you have a security report and
asks for a contact address — no details, no reproduction steps — and you will be given one.

A useful report contains:

- the version or commit, and whether it is the Docker image or a local/desktop install
- the deployment shape: reverse proxy in front, exposed to the internet or on a private network
  (Tailscale, LAN), single user or shared machine
- what an attacker can do that they should not be able to, and what they need to start with (a valid
  API token, a session, a file they can get ingested, a URL the server will fetch)
- reproduction steps or a proof of concept, and the impact you think it has

Reports in English or German are both fine.

## What to expect

| Stage | Target |
|---|---|
| Acknowledgement that the report arrived | 3 working days |
| First assessment: accepted, needs more information, or out of scope with a reason | 14 days |
| Fix in `main` for an accepted high-severity issue | 30 days, or an explanation of why longer |
| Public advisory and release | Coordinated with you, normally when the fix ships |

These are the intentions of a solo maintainer, not a contractual SLA. If you have had no reply after
a week, send a reminder through the same channel — silence means the message was missed, not
ignored.

Credit is given in the advisory under whatever name you choose, or withheld if you prefer. There is
no bug bounty.

## Threat model in v1

Two design decisions shape what counts as a vulnerability. Both are deliberate, both are recorded,
and both will be revisited.

### Plugins are trusted and run in-process

Plugins load inside the server process and are trusted (ADR-0012, and ADR-0018 for why this stands
through 1.0). The manifest declares permissions, and those permissions are recorded, shown at
install time and checked against actual hook use by the compatibility test suite — but they are
**not** enforced by isolation.

In plain words: **installing a third-party plugin grants it the full rights of the server process.**
It can read and write the whole library, read your API tokens and resolver keys, reach the network,
and touch any file the server user can touch. Installing a plugin has the same trust profile as `npm
install` or adding a Docker sidecar: judge the author, not the manifest.

Consequently, a report that a plugin can do something a plugin should not be able to do is not a
vulnerability in Recueil — it is the documented design. What *is* a vulnerability:

- a way to get a plugin installed, enabled or updated **without** a deliberate action by the
  operator
- a way for untrusted content — an ingested document, a fetched URL, a resolver response — to reach
  a plugin's or the host's code execution path
- the host failing to record a plugin's actions in the audit log, or misreporting its permissions

Sandboxing starts when one of the triggers in ADR-0018 fires (multi-user, a hosted deployment, or
automatic plugin installation).

### Single user, scoped tokens, no tenancy boundary

v1 is single-user (CONCEPT.md §2, §5.15). Authentication is a session for the web UI and scoped API
tokens for everything else; the data model has users and groups so multi-user can be added later,
but there is no tenancy boundary to breach today, and privilege separation between identities is not
a property the code claims.

So a report that one token can see another token's data is expected behaviour unless the scopes on
that token say otherwise; a report that a **scope restriction is not enforced** — a read-only token
that can write, a collection-scoped token that reaches the whole library, a token that stays valid
after revocation — is a real finding and wanted.

Recueil also assumes the operator's deployment does its part: TLS terminates at a reverse proxy,
secrets come from the environment, and the server is not exposed to the public internet without
authentication in front of it. Missing TLS in the container itself is not a finding.

### Always in scope

Regardless of the above, these are always worth reporting:

- authentication or session flaws: token forgery, session fixation, bypass of the login,
  authentication missing on an endpoint that should have it
- injection into the database, the search index or the shell
- path traversal or hash confusion in the content-addressed store, or any way to make the server
  write outside its storage root
- server-side request forgery through the resolvers, the connector, the WebDAV/IMAP sources or any
  URL the server fetches on request
- parser and ingestion issues: a crafted PDF, EML, RIS, BibTeX or zip that causes code execution, a
  zip bomb or path escape during archive extraction, or resource exhaustion from one file
- XSS in the web UI, including through item metadata, notes, annotations or plugin-contributed
  panels
- secrets leaking into logs, error responses, exports, backups or the analytics Parquet bundle
- anything that lets an unauthenticated caller reach data or actions at all

## Dependencies

A vulnerability in a dependency or a sidecar (GROBID, OCRmyPDF, Meilisearch, translation-server)
should be reported upstream first. Tell us as well if Recueil's use of it makes the impact worse or
if a pinned version needs moving — that part is ours.
