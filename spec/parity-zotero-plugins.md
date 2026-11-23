# Parity specification: the three Zotero plugins Phase 3 retires

Recorded on 2026-11-21 from the sources of [CTTIR/metadata-mender](https://github.com/CTTIR/metadata-mender) (v0.6.2), [CTTIR/attaclone-dedup](https://github.com/CTTIR/attaclone-dedup) and [CTTIR/argus-one](https://github.com/CTTIR/argus-one), as the basis for the CONCEPT §7 Phase 3 exit criterion ("parity tests against the three Zotero plugins on the fixture library pass"). File:line references are into those repositories at the commits current on that date.

```text
BEHAVIOURAL SPECIFICATION: metadata-mender, attaclone-dedup, argus-one
(All paths are absolute. "MM" = metadata-mender/content/metadata-mender.js, "AD" = attaclone-dedup/content/attaclone-dedup.js, "AR" = argus-one/src/argus-one/argus.js.)

THREE FINDINGS FIRST. Several things the brief asks about do not exist in the code:
1. metadata-mender has no adaptive backoff. It uses a fixed requests-per-second rate per source, and that rate depends only on whether the user has set a key (MM:85-112). Nothing slows down after a 429 or speeds back up later. The only "adaptation" is a bounded retry on each request (MM:166-173).
2. attaclone-dedup has no near-duplicate detection: no simhash, no text extraction, no matching on filename or size. It groups only by exact SHA-256 of the file bytes, and only among PDF attachments of the same parent item (AD:81-97, 146-166). Older versions grouped by filename+size; that was removed on purpose (CHANGELOG.md:32; docs/maintenance-2026-10-30.md:25).
3. argus-one matches records on exact normalised DOI only. It has no fuzzy matching, no title/year/author comparison, no blocking, and no PMID/PMCID/arXiv/ISBN handling (AR:78-97, 136-157; README.md "No fuzzy matching of parent records"). The merge itself is handed to Zotero's own merge function (`mergeItems.mjs` / `Zotero.Items.merge`). Collection, tag and relation union, moving children to the survivor, merging attachments, keeping the earliest dateAdded and undo are all Zotero behaviour, not plugin code (AR:181-192, 302-304).

======================================================================
1. METADATA-MENDER (v0.6.2, manifest.json; Zotero 9.0–10.0.*)
======================================================================

1.1 Preferences and defaults (MM:17-30, 49-73; content/preferences.xhtml)
Prefix: `extensions.metadata-mender.` Defaults are written only if the pref is unset; existing user values are never migrated (MM:71).
- openalexKey, ncbiKey, crossrefMailto, crossrefPlusToken, semanticScholarKey, coreKey: all default "".
- sourcePriority: "pubmed,openalex,crossref,semanticscholar,openaire,unpaywall,core,cran".
- overwriteMode: "fill". The other value is "overwrite".
- initialsGivenNames: false.
- titleFallback: false.
- tagPolicy: "latest". The other values are "history" and "stable".
- concurrency: 4. It is clamped to 1..12, and parseInt failure falls back to 4 (MM:1428-1431).
- Trap: `_getSourcePriority` (MM:935-940) uses "crossref,pubmed,semanticscholar,openalex" when the pref is empty or falsy. This differs from the installed default. The list is split on commas and trimmed, and empty entries are dropped.

1.2 Identifier extraction and pre-flight checks
- DOI (MM:302-317): the native DOI field is used first; otherwise the first Extra line matching `^\s*DOI:[ \t]*(\S+)` (multi-line, case-insensitive).
  - `_normalizeDOI`: trims, then strips `^https?://(dx\.)?doi\.org/` and `^doi:\s*` (case-insensitive). It does NOT change case.
  - `_canonicalDOI` = normalise + lowercase (MM:942-944). Used for all comparisons.
- PMID (MM:319-327): the native PMID field if the item type has one (trimmed); otherwise Extra `^\s*PMID:[ \t]*(\d+)`.
- PMCID (MM:329-338): accepts `^PMC([1-9]\d*)$` (case-insensitive), output as `PMC<n>`. Also accepts these URL forms only:
  - `https?://(www.)?ncbi.nlm.nih.gov/pmc/articles/(PMC)?<n>/?`
  - `https?://pmc.ncbi.nlm.nih.gov/articles/(PMC)?<n>/?`
  Anything else gives null; for example "PMC0", trailing text and lookalike hosts are rejected. This is applied only to OpenAlex `ids.pmcid`. PubMed, OpenAIRE and S2 take the first `/PMC\d+/` match from their PMC id.
- CRAN (MM:342-351):
  - URL field matching `^https?://cran.r-project.org/(package=NAME/?|web/packages/NAME(/(index.html)?)?)([?#].*)?$` (case-insensitive), where NAME = `[A-Za-z][A-Za-z0-9.]*`.
  - Otherwise Extra `^\s*CRAN:[ \t]*NAME[ \t]*$`.
- `_identifierProblem` (MM:353-376) runs before any network call. The item is SKIPPED if:
  - any DOI value (native field plus every Extra `DOI:` line) fails `^10\.\d{4,9}\/\S+$` after canonicalisation, or there is more than one distinct canonical DOI;
  - any PMID value (native field plus every Extra line) fails `^\d+$`, or there is more than one distinct PMID;
  - any CRAN value (every Extra `CRAN:` line plus the chosen CRAN id) fails NAME, or there is more than one distinct name.
  The reason text is "<field> identifiers are invalid or conflict; review before lookup".
- With no DOI, PMID or CRAN id, and titleFallback on, the title search runs (1.4). If it still finds nothing: skipped, "no DOI, PMID, or CRAN id" (MM:1298-1312).
- When a CRAN id is present, the priority list is filtered to "cran" only. Other sources are not queried, even if a DOI exists (MM:1314).

1.3 Sources: endpoints, parameters, headers, and what each returns
Common HTTP behaviour (`_get`, MM:139-175):
- Host allow-list: api.openalex.org, api.crossref.org, eutils.ncbi.nlm.nih.gov, api.semanticscholar.org, api.openaire.eu, api.core.ac.uk, api.unpaywall.org, crandb.r-pkg.org. HTTPS only; anything else throws "Unapproved metadata endpoint".
- Header on every request: `User-Agent: MetadataMender/<version||0.1.0> (https://github.com/CTTIR/metadata-mender; mailto:<email>)`. Without an email the tail is just `)` (MM:186-190). The mailto therefore goes to every provider, not only Crossref.
- Request options: responseType json, timeout 30000 ms, successCodes:false, errorDelayMax:0, noRetryOnThrottle:true, anon:true, followRedirects:false.
- Sources are fetched one after another, in priority order, for each item (MM:985-1011). A null record is not an error. A thrown error is stored as `errors[src]`.

Per source:
- OpenAlex (MM:382-441)
  - Request: GET `https://api.openalex.org/works/https://doi.org/<encodeURIComponent(doi)>`; or, with only a PMID, `/works/pmid:<pmid>`. With a key, the header is `Authorization: Bearer <key>`; the key is never put in the URL (test reconciliation.test.js:420).
  - Fields: title (title || display_name), DOI (normalised data.doi), date = publication_date, url = primary_location.landing_page_url, journal = primary_location.source.display_name, ISSN = source.issn_l, language (normalised), citedByCount.
  - Ids: PMID from ids.pmid via `(?:/|^)(\d+)/?$`; PMCID (normalised); openalexID = last path segment of ids.openalex (or data.id).
  - oaPdfUrl = best_oa_location.pdf_url, else its landing_page_url.
  - volume, issue, and pages "first-last" (or first only) from biblio.
  - creators = `_splitName(display_name)`.
  - abstract rebuilt from the inverted index: words placed by position, joined with single spaces (MM:911-917).
  - `_sourceId` = last segment of the source id, used for the venue lookup.
- OpenAlex venue (MM:276-297; 1013-1021)
  - Request: GET `/sources/<Sxxx>`. The id must match `^S\d+$`.
  - The response is accepted only if `data.id === "https://openalex.org/<sid>"`.
  - impactFactor2yr = summary_stats["2yr_mean_citedness"], only if finite and ≥0.
  - Cache: `_sourceCache[sid] = {day: UTC YYYY-MM-DD, data}`. It is reused only on the same UTC day. Errors are not cached and return null. A 404 null is cached. The cache is reset on init.
- Crossref (MM:443-496)
  - Request: GET `https://api.crossref.org/works/<encodeURIComponent(doi)>`, plus `?mailto=<email>` if an email is set. With a Plus token, the header is `Crossref-Plus-API-Token: Bearer <token>`.
  - The record is accepted only if status === "ok" and message is present.
  - Fields: title[0], container-title[0] → journal, volume, issue, page → pages, publisher, URL → url, ISSN[0], short-container-title[0] → journalAbbreviation, language.
  - date from the first of published, published-print, published-online date-parts[0], joined with "-", month and day zero-padded to 2 digits.
  - creators: {firstName: given||"", lastName: family||name||""}.
  - abstract: tags stripped with `<[^>]+>`, then trimmed.
  - citedByCount = is-referenced-by-count.
- PubMed (MM:498-553)
  - With no PMID but a DOI: esearch `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&term=<encodeURIComponent(doi)>[DOI]` (the brackets are not encoded), plus `&api_key=` if a key is set. The first idlist entry is used.
  - Then esummary `.../esummary.fcgi?db=pubmed&retmode=json&id=<id>[&api_key=]`, reading `result[id]`.
  - Fields: title; journal = fulljournalname || source; volume; issue; pages.
  - date = sortpubdate up to the first space, with "/" replaced by "-"; otherwise pubdate.
  - PMID = uid. DOI/PMCID from articleids (idtype "doi"; "pmc" or "pmcid").
  - ISSN = issn. journalAbbreviation = source. language = normalised lang[0].
  - creators: only authtype "Author" or "CollectiveName" with a non-empty name.
    - CollectiveName → {firstName:"", lastName:name, fieldMode:1}.
    - Author → `_splitName(name, true)`: the last token is the initials, everything before it is the surname (so "van der Waals JD" → last "van der Waals", first "JD").
- Semantic Scholar (MM:555-604)
  - Request: GET `https://api.semanticscholar.org/graph/v1/paper/<encodeURIComponent("DOI:"+doi | "PMID:"+pmid)>?fields=externalIds,title,abstract,year,publicationDate,journal,venue,authors,citationCount`. Header `x-api-key` if a key is set.
  - Requires paperId in the response.
  - date = publicationDate || year.
  - DOI, PMID (PubMed), PMCID, and arXivID (ArXiv) from externalIds.
  - journal = journal.name (plus volume and pages from journal), else venue.
  - creators via `_splitName`. citedByCount.
- OpenAIRE (MM:610-674)
  - Request: GET `https://api.openaire.eu/graph/v1/researchProducts?pid=<doi>&pageSize=1`. Uses results[0].
  - title/description: the first element if it is an array.
  - date = publicationDate; publisher.
  - container: name, vol, iss, sp-ep pages, ISSN = issnPrinted || issnOnline || issnLinking.
  - authors: if the name contains ",", split as "Last, First"; otherwise `_splitName`.
  - pids: doi, pmid, pmc/pmcid.
  - oaPdfUrl = the first instance whose accessRight is "OPEN" or "OPEN ACCESS" (urls[0] or url).
- CORE (MM:676-716)
  - Called only if coreKey and a DOI are present.
  - Request: GET `https://api.core.ac.uk/v3/search/works?q=<encodeURIComponent('doi:"'+doi+'"')>&limit=1` with `Authorization: Bearer <key>`.
  - Fields: title, abstract, date (publishedDate || datePublished up to "T", else yearPublished), publisher, DOI, coreFullTextUrl = downloadUrl, authors, journals[0].title, and ISSN from an identifier starting "issn:".
- Unpaywall (MM:720-747)
  - Called only if a DOI and crossrefMailto are present.
  - Request: GET `https://api.unpaywall.org/v2/<doi>?email=<email>`.
  - Fields: DOI, title, date = year, journal_name, journal_issn_l → ISSN, publisher, creators from z_authors.
  - oaPdfUrl = best_oa_location.url_for_pdf, else its url.
- CRAN (MM:751-819)
  - Request: GET `https://crandb.r-pkg.org/<name>`. Requires `Package`.
  - Fields: title = Package; CRAN = Package; publisher "Comprehensive R Archive Network (CRAN)"; url `https://cran.r-project.org/package=<Package>`; programmingLanguage "R".
  - abstract = Description (else Title), with whitespace collapsed.
  - versionNumber = Version.
  - date = Date/Publication || date || Date, cut at the first space or "T".
  - Authors from DESCRIPTION: split on commas at bracket depth 0, strip `[...]` and `(...)`, then `_splitName`.
  - cranLicense = License; cranUpstreamUrl = the first entry of URL split on commas or whitespace.

1.4 Matching and identity checks
- Identity of each returned record (`_checkIdentity`, MM:975-983). A failure turns that source into an error and drops its record.
  - CRAN: record.CRAN === ids.cran.
  - If the item has a DOI: the record's canonical DOI must equal the item's canonical DOI. A record with no DOI fails.
  - If the item has a PMID and the record has a PMID, they must be equal.
  - If the item has a PMID but no DOI: the record's PMID must be present and equal.
- Conflict with the local reference (MM:1317-1330, all sources except cran). The source is dropped with "Metadata conflicts with the current reference; review its identifiers" if either:
  - the item has a title, the record has a title, and `_titleSimilar` < 0.8; or
  - the item's first author-type creator has a lastName, the record has creators, and no record creator has an equal `_nameKey(lastName)`.
- `_titleSimilar` (MM:256-273): Jaccard similarity on sets of tokens. Text is lowercased, NFKD-normalised with combining marks removed, every non-letter/number/space replaced by a space, split on whitespace, and tokens of length ≤2 dropped. If either set is empty the result is 0.
- `_nameKey` (MM:946-948): NFKD, marks removed, lowercased, everything except letters and digits removed.
- Title search for a DOI (`_tryTitleFallback`, MM:823-853). Opt-in only.
  - Preconditions: title length ≥20; a 4-digit year found in date with `\b(\d{4})\b`; a first author-type creator with lastName; a non-empty publicationTitle; and an item type in this map:
    - journalArticle → [journal-article]
    - conferencePaper → [proceedings-article]
    - bookSection → [book-chapter, book-section]
    - preprint → [posted-content]
  - Request: GET `https://api.crossref.org/works?query.bibliographic=<title>&rows=5&query.author=<lastName>[&mailto=]`.
  - A candidate is accepted only if all of these hold:
    - Jaccard(title) ≥ 0.92;
    - candidate.type is in the allowed list;
    - a year from published, published-print, published-online or issued date-parts[0][0] is within ±1 of the item's year;
    - some candidate author's family||name nameKey equals the item author's lastName nameKey;
    - some container-title nameKey equals the publicationTitle nameKey;
    - the canonical (lowercased) DOI is valid.
  - It returns a DOI only if the set of accepted DOIs has exactly 1 member; otherwise null.
  - A thrown error gives status "error", reason "title lookup failed".
  - On success, provenance["DOI-via-title"] = "crossref-search" (MM:1354-1356).

1.5 Writing to the item
Before writing (MM:1358-1360): `_writeProblem` (MM:966-973) is re-checked, and the snapshot (MM:957-964) must equal the one taken before lookup. The snapshot covers fields (mapped merge fields + extra, PMID, PMCID, arXiv), creators, tags, libraryID, itemTypeID and deleted. Otherwise: skipped, "item changed during lookup; retry after review".
Order of steps: `_mergeStandardFields` → `_mergeCreators` → `_normalizeCreatorInitials` → `_augmentExtra` → tag → saveTx (MM:1362-1373).

- Standard fields (MM:922-928, 1023-1059)
  - Fields: title, date, DOI, journal (→ publicationTitle), volume, issue, pages, ISSN, abstractNote, url, publisher, journalAbbreviation, language, versionNumber, programmingLanguage.
  - Precedence: for each field independently, the first source in priority order with a value that is not undefined, null or "".
  - If the field is not valid for the item type: DOI goes to Extra "DOI: <v>" (appended only if missing); versionNumber goes to Extra "Version: <v>"; any other field is dropped.
  - Fill mode skips fields that already have a value. Any mode other than "fill" overwrites. A value equal to `String(chosen)` is skipped.
  - No other normalisation is done at write time: no title case, no ISSN hyphenation, no page-range rewriting, no DOI lowercasing (the DOI is stored as the source gives it after prefix stripping). Only the per-source conversions in 1.3 apply.
- Creators (MM:1061-1088)
  - The first source in priority with a non-empty creators array wins.
  - If the item already has creators and mode !== "overwrite", nothing changes. So creators are only filled when empty, or replaced in exact "overwrite" mode.
  - No change is recorded if the comparable list (firstName, lastName, fieldMode, creatorTypeID) is identical.
- Initials (MM:861-896)
  - Only if initialsGivenNames is true. In fill mode, only if creators were written in this run.
  - Every creator with fieldMode !== 1 and a firstName gets `_toInitials`: split on whitespace or hyphen and remove dots; a part that is already all-uppercase and matches `^[^\d]{1,4}$` is kept whole; otherwise the first character is uppercased. Examples: "Raban Arved" → "RA", "Jean-Pierre" → "JP", "J." → "J", "RA" → "RA".
- Name splitting (MM:898-909): by default the last whitespace token is lastName and the rest is firstName. PubMed mode is reversed (see PubMed above).
- Language (MM:243-252): eng→en, fre/fra→fr, ger/deu→de, spa→es, ita→it, por→pt, dut/nld→nl, rus→ru, chi/zho→zh, jpn→ja, kor→ko, ara→ar, pol→pl, swe→sv. Anything else is unchanged.
- Extra lines (`_augmentExtra`, MM:1090-1255)
  Helpers:
  - `_upsertExtraLine` (MM:198-219): replaces the first `^\s*Key\s*:` line (case-insensitive), deletes later duplicates, appends if absent, trims blank lines at both ends, and keeps the original separator style (\r\n, \n, \r, U+2028, U+2029).
  - `_appendExtraLineIfMissing` (MM:221-227): if the key is absent, appends with "\n".
  - `_removeExtraLine` (MM:231-239).
  Steps:
  1. Deferred field values (DOI, Version): append if missing.
  2. Identifiers: PMID (first source with PMID, else the local PMID), PMCID, arXiv (from arXivID), OpenAlex (Extra only).
     - Fill-mode skip: if the native field is non-empty and differs, OR any existing Extra line for the key has a non-empty value that differs, the identifier is left untouched.
     - Native field valid for the type: set it if different, then remove every Extra line for that key.
     - Otherwise: upsert the Extra line. In overwrite mode this replaces a conflicting value. The README says "append once"; that is not exact.
  3. Citations (MM:1154-1183): OpenAlex citedByCount if it is a safe integer ≥0; otherwise the first source in priority among openalex, crossref and semanticscholar with a valid count. Line `Citations: <n> [<OpenAlex|Crossref|Semantic Scholar>, YYYY-MM-DD]`, upserted in every mode.
  4. Mean citedness (MM:1185-1195): if impactFactor2yr is finite and ≥0, line `OpenAlex 2yr mean citedness: <toFixed(2)> [OpenAlex 2yr mean citedness, YYYY-MM-DD]`, upserted. Existing "Impact Factor:" lines are kept.
  5. OA URL (MM:1199-1216): the first of openalex.oaPdfUrl, unpaywall.oaPdfUrl, openaire.oaPdfUrl, core.coreFullTextUrl. This order is fixed and ignores the priority setting. Line `OA-URL: <url>`, upserted.
  6. CRAN (MM:1218-1243): append if missing `CRAN: <name>`, `License: <license>`, `Upstream-URL: <url>`.
  7. Provenance (MM:1246-1252): if provenance is non-empty, upsert `Provenance: YYYY-MM-DD — key:src, key:src` (an em dash, in insertion order).
  - "today" is the UTC date `new Date().toISOString().slice(0,10)`.
- Tags (MM:1257-1276). Applied only when changes were made.
  - "stable": addTag("mended", type 1).
  - "latest": remove automatic (type 1) tags equal to "mended" or matching `^mended:\d{4}-\d{2}-\d{2}$`, then add `mended:<today>` (type 1).
  - Any other value (including "history"): add `mended:<today>` (type 1).
  - Manual (type 0) tags are never removed. Tagging errors are logged and swallowed.
- Save and rollback (MM:1374-1388). If any error happens during mutation or save:
  1. `item.reload(["primaryData","itemData","creators","tags"], true)`;
  2. `_clearChanged` for each of those categories;
  3. throw "Metadata changes were not saved; the original item was reloaded".
  If reload or clear itself fails: throw "Metadata save failed and item reload failed; reopen Zotero before continuing".

Per-item result statuses:
- skipped: write problem (not regular, trashed, read-only library, pending edits, cancelled), "item is already being processed" (in-flight set, MM:1281), identifier conflict, no ids, or changed during lookup.
- error: title lookup failed; or no records left but errors exist ("no verified source metadata; lookup or identity checks failed").
- notfound: no records and no errors.
- updated: includes changes, sources and errors.
- unchanged.

1.6 Rate limiting: the exact algorithm (MM:82-134)
- Each source has its own queue `{last, chain}`. minInterval = 1000 / rps(source).
- Each call is chained after the previous call on that source has settled. It then waits max(0, last + minInterval − now), sets last = now, and runs fn.
- Effect: requests to one source run one at a time, with at least minInterval between their start times. Retries inside `_get` (including Retry-After waits) happen inside fn, so they hold that source's queue.
- RPS constants:
  - openalex 10
  - pubmed 3, or 10 with ncbiKey
  - crossref 20, or 50 with crossrefPlusToken (the mailto does not change the rate)
  - semanticscholar 1, or 5 with key
  - openaire 10
  - core 1/6 (one request per 6000 ms)
  - unpaywall 10
  - cran 5
  - any other source 2
- The rps is re-read from prefs on every schedule() call. The queues are reset on init.
- No adaptive state: the rate is never lowered on 429/5xx and never raised on success.
- Retries (MM:166-184):
  - Status 2xx: the body must be a non-array object; otherwise "Invalid metadata response (<host>)".
  - 404 → null.
  - 429 or 500–599 with attempt < 3: wait = parseRetryAfter(header) ?? 2^attempt × 1000. That means 2000 ms after attempt 1 and 4000 ms after attempt 2. If wait ≤ 30000, delay and retry; if larger, fail immediately. At most 3 requests in total.
  - Other statuses throw "HTTP <status> (<host>)". Transport errors throw "Metadata request failed (<host>)", never the URL.
  - parseRetryAfter: a plain decimal number gives seconds × 1000 (minimum 0). Otherwise an HTTP-date gives max(0, date − now). Otherwise null. "0" gives 0, which means an immediate retry.
  - Cancellation is checked before and after each request.
- Batch processing (MM:1391-1536)
  - Global `_running` lock; a second run is refused with an alert.
  - workers = min(concurrency, number of items), pulling from a shared index.
  - Pressing Esc sets `_cancelRequested`; workers stop taking new items.
  - If a worker throws (for example because the progress UI broke), cancel is set, all workers are awaited, then the error is re-thrown. The lock is released and the keydown listener removed on every exit path.
  - Report: counts of updated, unchanged, skipped, notfound and errored. Failure detail lines for up to 5 items ("title (≤60 chars) — src: msg · …"), then "…and N more". Full details go to Zotero.debug. Results with status ≠ error but with per-source errors are also listed, as "some sources could not be verified".
  - The progress window closes after 15000 ms if there were failures, otherwise 8000 ms.

1.7 metadata-mender tests (parity candidates)
tests/helpers.test.js (pure helpers):
- `_normalizeDOI` strips https://doi.org/, https://dx.doi.org/, "doi: " and whitespace.
- `_splitName` "John Smith" → John/Smith; "Mary Jane Watson" → "Mary Jane"/Watson; "" → empty.
- `_splitName(lastFirst)` "Smith JA" → JA/Smith; "Müller H" → H/Müller.
- `_reconstructAbstract` orders words by index, including repeated words.
- `_upsertExtraLine` appends when absent ("PMID: 123" → "PMID: 123\nCitations: 5"; "" → "PMID: 9").
- `_upsertExtraLine` replaces in place, case-insensitively.
- `_upsertExtraLine` removes duplicates: "Citations: 1\nfoo: bar\nCitations: 2" → "Citations: 9\nfoo: bar".
- `_toInitials` examples, including that it is idempotent ("RA" → "RA", "J." → "J", "" → "").
- `_removeExtraLine` is case-insensitive, trims blanks, and leaves the text unchanged if the key is absent.
- `_normalizeLang`: eng/ENG → en, ger → de, en → en, xyz → xyz, "" → "".
- `_appendExtraLineIfMissing` does nothing if the key exists and appends otherwise.
- `_parseRetryAfter`: "30" → 30000, "0" → 0, ""/null → null, a past HTTP-date → 0.
- `_today` matches YYYY-MM-DD.
- `_titleSimilar`: identical → 1; differences only in case and punctuation → 1; partial overlap gives a value strictly between 0.3 and 1; disjoint → 0; tokens of 2 chars or fewer ignored ("a of in on it" vs "x of in on it" → 0).
- `_parseRDescriptionAuthors`: role tags stripped; splits only on top-level commas; ORCID removed; ""/null → [].

tests/reconciliation.test.js (harness: tests/harness.cjs; priority "crossref"; item DOI 10.1234/synthetic):
- Defaults are fill / initials false / titleFallback false, and an existing fill or overwrite choice survives initialisation.
- Fill mode keeps the existing full first name "Example" even with initials on; fills the missing volume "4"; keeps the conflicting "PMCID: PMC111" in Extra; keeps the manual tag "mended:manual-review"; never writes PMCID natively.
- An unsupported native PMID goes to Extra "PMID: 12345" without calling setField(PMID).
- PubMed: compound surname "van der Waals"/"JD" is kept; a returned uid 99999 for requested 12345 gives error and 0 saves.
- Each of these gives error, 0 saves and 0 writes, even in overwrite mode: wrong returned DOI, missing DOI, unrelated title, author with a different surname.
- Read-only library, trashed item and pending-edit item are all skipped with 0 network calls.
- These are skipped with 0 calls: conflicting DOI in Extra vs field; two different PMIDs; invalid PMID "12345invalid"; CRAN URL dplyr vs Extra ggplot2. The CRAN parser rejects `example.org/cran.r-project.org/...` and accepts `package=ggplot2` and `web/packages/data.table/index.html`.
- An external save during lookup gives skipped, and the external value is kept.
- Cancellation during lookup gives skipped with no writes.
- A failed save causes one reload, the snapshot equals the one before, and the item is not dirty.
- A setter throwing midway rolls back with no save.
- Two concurrent reconcileItem calls on the same item: the second is skipped, and there is exactly 1 save.
- Title search: a concordant candidate returns its DOI. A different type, author, year (2001 vs 2020) or journal returns null. Two distinct DOIs return null.
- A 429 with Retry-After 86400 fails as "HTTP 429 (api.openalex.org)" with no delays and 1 request; a transport error message is sanitised.
- The OpenAlex key goes in the Authorization header, not the URL, and followRedirects is false.
- Option contract: a 503 with Retry-After "2" gives 3 attempts and delays [2000, 2000]; a 404 returns null.
- The mean-citedness line is written as "OpenAlex 2yr mean citedness: 2.50", and "Impact Factor: 4.1 [manually verified]" is kept.

tests/integrity.test.js:
- In fill mode, conflicting duplicate Extra values for PMCID, arXiv and OpenAlex (with or without a native field) give unchanged, with Extra byte-identical and 0 saves.
- Equal duplicate PMCID lines are merged into 1 (updated), and the review text is kept.
- Venue cache: a wrong source id gives no metric. The second call on the same day uses the cache (calls stay 2). The next UTC day refetches (calls 3).
- Invalid OpenAlex counts or metrics (-1, NaN, Infinity, "3") fall back to "Citations: 0 [Crossref, ", and the old citedness line is kept. citedByCount 1.5 writes no Citations line. Citedness 0 is written as "0.00".
- If creating the progress window fails, listeners are removed and `_running` is false.
- A progress failure on the 2nd tick: the lock is held until the delayed worker settles, the second item has 0 saves, the first has 1 save, and the error is propagated.
- Line endings LF, CRLF, CR, U+2028 and U+2029: a non-native identifier leaves Extra unchanged. A native identifier promotion removes the Extra line, giving "Manual synthetic review note\nProvenance: … PMCID:crossref".
- An Extra-only PMID gives "PMID: 12345\nProvenance: <date> — PMID:pubmed" and is unchanged on the second run (1 save). CRAN Upstream-URL gets provenance "Upstream-URL:cran" and is unchanged on the second run.
- OpenAlex PMCID: accepted forms → "PMC123"; lookalikes, "PMC0", trailing text, numbers and objects → undefined.
- PubMed CollectiveName → {firstName:"", lastName, fieldMode:1}. Investigator, empty-name and null entries are dropped. Initials are applied to the personal author (who is already "JD").
- After a failed save, pending tags are discarded; the retry gives exactly one dated mended tag and keeps the manual tag.
- An item dirty before or during lookup is skipped with no reload or clear. A failed reload throws "reload failed; reopen Zotero" and leaves the item dirty. A missing `_clearChanged` takes the same path.

tests/localization.test.js (bootstrap Fluent):
- The Fluent source is registered once across multiple windows, with locale ["en-US"] and path "chrome://metadata-mender/locale/{locale}/". Shutdown removes it once.
- A missing window logs "English fallbacks" and retries on the next window. After shutdown it does not register again.
- A constructor that throws gives no false registration.

Build-only tests (not behavioural): tests/package.test.js, tests/test_package_boundaries.py, tests/test_native_runner.py.
tests/native/fixture.js (a real Zotero session):
- Fill keeps the reviewed title and full creator name and adds volume 7.
- A wrong DOI is refused.
- After an injected save failure the issue field is cleared and the item is not dirty.

======================================================================
2. ATTACLONE-DEDUP (v1.0.1; Zotero 10.0.x)
======================================================================

2.1 Preferences (AD:38-49; content/preferences.xhtml)
- `extensions.attaclone-dedup.dryRun`: default true. Any value other than strictly false is treated as dry run (AD:196, 225, 290).
- keepStrategy: "oldest" (default) or "newest".
- The legacy `moveToTrash` / erase pref is ignored. Permanent erase is not supported (safety.test.js "legacy erase preference…").

2.2 Scope and entry points (AD:362-414)
- Selected items: regular items only.
- Selected collection: `getChildItems(false,false)`. Direct children only, not recursive; trashed items excluded.
- Whole library: asks for confirmation, then `Zotero.Items.getAll(libraryID, true)` (top-level items), filtered to regular items.
- Duplicates are only looked for among the file attachments of ONE parent item. There is no cross-item detection.

2.3 Detection: exact hash only (AD:81-166)
- For each child of the parent: non-file attachments are skipped silently.
- For each file attachment, `_attachmentMeta` throws (so the attachment is excluded from grouping and a warning "Attachment <id>: <msg>" is recorded) if any of these holds:
  - it is deleted, or not a file attachment;
  - its key does not match `^[A-Z0-9]{8}$`;
  - it is not a PDF (`isPDFAttachment()`; multi-file HTML snapshots are therefore excluded);
  - it has any outgoing relation values, or any incoming relation (`Zotero.Relations.getByObject("item", itemURI)`);
  - any note in the same library, live or trashed, contains the attachment key as a substring: SQL `SELECT itemNotes.itemID FROM itemNotes JOIN items USING (itemID) WHERE items.libraryID=? AND itemNotes.note LIKE '%KEY%' LIMIT 1` (AD:114-119);
  - it has any external annotation (`annotationIsExternal`). Annotations are read with `getAnnotations(true)`, which includes trashed ones;
  - any annotation `hasChanged()` (pending edits);
  - the file is missing; the stat type is not "regular"; the size is ≤0; the hash is not 64 hex characters; or the size or lastModified changed between the stat before and the stat after hashing.
- Hash: `IOUtils.computeHexDigest(path, "sha256")`, lowercased. The group key is "sha256:<hex>".
- Any exception during inspection (getAnnotations, getNote, getTags, the DB query) fails closed: the attachment is excluded.
- Fields captured per member:
  - id, libraryID, parentID, key, path, size, lastModified;
  - filename (attachmentFilename || display title), contentType, dateAdded, dateModified;
  - annotationCount, annotationIDs (sorted), annotationState [id, dateModified, deleted];
  - tagCount, tags (sorted names), note, hasNote (note.trim() non-empty), linkMode.
- A group is formed when two or more members share a key. If parent or library differs from the scanned item, the attachment is rejected.

2.4 Routing (AD:168-183, 282-335)
- Automatic resolution (`_canAutoResolve`) requires ALL of:
  - the key matches `^sha256:[a-f0-9]{64}$`;
  - at least 2 members;
  - the first member's linkMode is an integer ≥0;
  - every member has: the same key, annotationCount 0, no attachment note, tagCount 0, size equal to the first member's, contentType exactly "application/pdf", and linkMode equal to the first member's.
- Every other verified group goes to the manual queue. The manual queue is processed after ALL items have been scanned, one modal dialog per group.
- Keeper for automatic resolution (`_pickKeeper`): sort ascending by Date.parse(dateAdded), with id ascending when the difference is NaN or 0. "oldest" takes the first; "newest" takes the last (so on a tie, the highest id). All other members are deleted.
- Manual dialog (content/manualResolve.js):
  - Every copy starts checked "Keep".
  - Keeping none is blocked with an alert.
  - "Move annotations from discarded copies to the kept copy" (default off) requires exactly 1 keeper.
  - Cancel ("Skip this item") gives result {skip:true}.
  - In dry run the intro reads "Dry run: preview your selection. No attachments or annotations will change."
  - The dialog says notes and tags are not merged.

2.5 Resolution and merge (AD:185-280)
- Selection check: keepIDs is non-empty; keep ∪ delete equals the group members exactly, with no duplicates or foreign ids. Otherwise "Invalid duplicate selection".
- No deletes → {changed:0, planned:0}.
- mergeAnnotations requires exactly 1 keeper. The key must match the sha256 pattern.
- `_revalidate` (run before the dry-run return and again inside the transaction):
  - parent and each member must be editable: not stopping; `_recoveryRequired` not set; not deleted; isEditable; library editable AND filesEditable; no pending edits;
  - full metadata is rehashed;
  - fields that must be equal: libraryID, parentID, key, path, size, lastModified, dateModified, note, linkMode, contentType;
  - annotationIDs, annotationState and tags must be equal;
  - parent, library and key must match the group.
- Dry run (frozen at scan start in `_runDryRun`, so turning dry run off during a scan does not cause writes): log "[DRY RUN] Would move N attachment(s) to Trash" and return {changed:0, planned:N}. No transaction is opened.
- Apply: one `Zotero.DB.executeTransaction` per group, containing:
  1. revalidate;
  2. `_assertApplyAllowed` (aborts if the plugin is stopping or the live dryRun pref is not false);
  3. keeper = keepIDs[0];
  4. for each delete id: if mergeAnnotations, call `Zotero.Items.moveChildItems(src, keeper, {includeTrashed:true})`. This moves the annotation objects themselves, so ids and keys are kept; nothing is cloned. Then set `attachment.deleted = true` and `save()`. `_assertApplyAllowed` is checked between steps.
- What survives: the keeper or keepers. Deleted copies go to Zotero Trash; files are never erased. The keeper's notes and tags are not merged with the deleted copies' (but automatic groups have none, and manual groups keep anything the user keeps).
- On failure: the transaction is rolled back. Every member and every annotation id is then reloaded with `reload(undefined, true)`. If any reload fails, `_recoveryRequired = true` and all later operations are blocked ("restart Zotero"). The original error is re-thrown.
- Reversibility: restoring from Trash brings back the attachment with the same identity and file. Annotation moves are NOT reversed by restoring (docs/vignette.qmd:48-49; docs/audit/2026-10-30.md:68-69). No merge log or undo record is written.
- Concurrency: the `_running` lock gives "A duplicate scan is already running". It is released in finally, including when reading prefs throws.
- Summary alert (AD:346-358):
  - itemsScanned
  - duplicatesFound (Σ (members − 1))
  - autoResolved
  - manualResolved
  - planned
  - manualQueued
  - failed
  - warnings
  - "DRY RUN: no library changes were made." in dry run
  - the first 10 warnings
  Errors at the UI level give "Scan stopped: <msg>".

2.6 attaclone-dedup tests
Fixture: tests/helpers.cjs. Two PDF copies of "verified example" under parent 10. dateAdded 2026-01-01 and -02. The manual dialog stub returns keep [1], delete [2], mergeAnnotations true.

tests/safety.test.js:
- If hashing fails, there are no groups, 2 warnings, and a "f:paper.pdf:16" key never auto-resolves.
- Different bytes of the same size never group.
- Dry-run manual annotation transfer: planned 1, saves, moves, erases and transactions all 0, and the annotation parent is unchanged.
- Apply: the annotation keeps id 100 and key KEEPKEY1 on the keeper; the source is deleted; saves 1, moves 1, transactions 1, erases 0.
- A moveChildItems failure: failed 1, the source is not deleted, 0 saves.
- A save failure rolls back the annotation transfer (parent 2, keeper has 0 annotations, the annotation is reloaded once).
- A failure after the annotation save reloads the cached parent.
- A failed cache reload sets `_recoveryRequired` and blocks later saves.
- Each of these gives autoResolved 0, 0 saves and warnings: non-PDF, outgoing relation, incoming relation, note link, external annotation, note-query exception.
- A note link added after the scan makes `_resolveGroup` reject with /note references/.
- An exception in getAnnotations, getNote or getTags gives no auto-resolve.
- Each of these after the scan rejects the resolve: changed bytes, new tag, parentID changed, deleted.
- library.editable false, filesEditable false, or a member with pending edits: failed 1, 0 saves.
- The erase preference is ignored; Trash only.
- These selections are rejected: keep none; a foreign delete id; the same id in keep and delete.
- scanLibrary uses getAll and reports "Items scanned: 1".
- The default dryRun is true, and a re-entrant scan is refused.
- Turning dryRun off during hashing keeps that scan as a preview (planned 1, prompt contains DRY RUN).
- Shutdown, or turning dryRun on during annotation transfer, rolls back before trashing (failed 1, annotation parent 2, 0 saves).

tests/safety.test.cjs:
- A missing digest, '', a 32-character digest or 'invalid' gives duplicatesFound 0 and 2 warnings.
- A stat exception, size 0, or a changing lastModified gives no auto-resolve and 2 warnings.
- These go to the manual queue: linkMode mismatch, empty contentType, undefined linkMode on all members.
- keepStrategy newest trashes id 1 and keeps id 2; erases 0.
- Concurrent scans: the second rejects with /already running/, and the lock is released afterwards.
- A pref exception releases the lock, and a later preview gives planned 1.
- An undefined dryRun pref gives no mutation.

tests/lifecycle.test.cjs:
- Startup imports IOUtils into the module scope.
- Shutdown deletes the namespace.
- Annotation merge with 2 keepers is refused.
- The dry-run dialog shows its label and starts with all copies kept.

tests/native/fixture.js:
- Real SHA-256 groups 2 identical PDFs and excludes a third of equal size with different bytes.
- The preview does not mutate.
- Apply trashes only the duplicate, and the file bytes remain.
- Restoring from Trash keeps identity and file.

Python tests are build and packaging only.

======================================================================
3. ARGUS-ONE (v0.1.1; Zotero 9.0–10.0.*)
======================================================================

3.1 Configuration: none. There are no prefs. The only entry point is the Tools menu item "Argus One: merge DOI duplicates…", registered through Zotero.MenuManager (AR:49-68; locale/en-US/argus-one.ftl).

3.2 Identifier normalisation (DOI only)
- normalizeDOI (AR:78-84): non-string → null. Otherwise trim, LOWERCASE, strip `^https?://(dx\.)?doi\.org/` then `^doi:\s*`, trim. Must match `^10\.\d{4,9}\/\S+$`, otherwise null. Suffix punctuation is kept ("10.1234/example." stays as is).
- getItemDOI (AR:86-97):
  - If the DOI field is valid for the type and non-empty: return normalizeDOI of it. If it is malformed the result is null, with NO fallback to Extra.
  - Otherwise collect all Extra lines matching `(?:^|\n)[^\S\r\n]*DOI[^\S\r\n]*:[^\S\r\n]*([^\r\n]*)` (case-insensitive key). If any value is invalid (including an empty value or trailing text), the result is null. If there is more than one distinct normalised value, null. Otherwise that value. Values differing only in case are equal after lowercasing.
- PMID, PMCID, arXiv and ISBN: not implemented.

3.3 Discovery (AR:136-157)
- Personal library only (userLibraryID), which must be editable.
- Zotero.Search with itemType isNot attachment, isNot note, deleted false.
- Keeps items that are regular, top-level, not deleted and in the same library. Groups by getItemDOI. Groups of size >1 are returned.
- No blocking or fuzzy stage.

3.4 Planning and eligibility (AR:112-179)
- validateGroup fails the group (it is added to skipped with a reason) unless:
  - there are at least 2 items with unique ids;
  - the first item has a DOI;
  - every item is in the user library, regular, top-level, not deleted, editable, has the same itemTypeID, and the same DOI;
  - no item has pending edits;
  - dateAdded matches `^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$` and is a real date, checked by a UTC round trip (so 2026-02-30, month 13 and hour 24 are rejected; 2024-02-29 is accepted).
- Order: dateAdded descending as a string, tie broken by id descending.
  - survivor = ordered[0], the newest.
  - losers = the rest, newest first.
- The plan is frozen: {doi, ids, snapshots, survivorKey, title, loserKeys}.
- Snapshot (AR:99-110) is JSON of: id, key, libraryID, itemTypeID, dateAdded, dateModified, version, deleted, used fields with values (sorted), creators, tags, collections (sorted), relations, attachment ids including trashed, note ids including trashed.

3.5 Merge (AR:258-313)
- Guards, in order:
  1. lifecycle is still active;
  2. the plan is re-frozen;
  3. `needsRestart` is not set;
  4. all ids load;
  5. a native merge function is available;
  6. no DB transaction is active (`Zotero.DB.inTransaction` is preferred over `transactionInProgress`; it must exist and return a boolean, otherwise the merge fails closed);
  7. validateGroup passes and the snapshots equal the plan's;
  8. the recovery scope is built;
  9. the transaction check, validateGroup and snapshot check are repeated;
  10. nothing in the scope has pending edits;
  11. lifecycle is still active.
- Field combination ("newest wins, fill blanks"):
  - For each loser (newest first), for each used field of the loser that is valid for the survivor's type: if the survivor's value is blank and the loser's is not, copy it.
  - Blank means false, null, undefined, or a string that is empty after trim. Numeric 0 is NOT blank.
  - Creators: if the survivor has none and the loser has some, copy them all from the first such loser.
  - These changes are not saved by the plugin; the native merge saves them.
- Then `merge(survivor, losers)`:
  - `ChromeUtils.importESModule("chrome://zotero/content/mergeItems.mjs").mergeItems`, else `Zotero.Items.merge`, else throw.
  - Per the docs and the native fixture, Zotero's merge then does: union of collections and tags; moving notes and attachments to the survivor; remapping annotations; retargeting incoming relations; replacement/citation identity; trashing losers; recording undo; keeping the EARLIEST dateAdded; and possibly merging attachments by PDF text or web title even when the files differ (README "Usage and merge policy"; docs/AUDIT-2026-10-30.md "Native API contract").
- Result: {survivorID, trashed: number of losers}.
- Recovery on failure (AR:194-243, 306-312):
  - The scope is: the group items; their attachments and notes (including trashed); annotations of file attachments; and same-library subjects of incoming relations pointing at the items or their attachments.
  - For each object in scope: unregister both the original and the current relation entries, `reload(null, true)`, then re-register the reloaded relations.
  - If any reload fails: `needsRestart = true`, and the error gets ". Restart Zotero before using the library; object recovery was incomplete" appended.
- Run (AR:315-352):
  - Lock: "Argus One is already running."
  - A preview confirmation lists, per plan, `<doi>\nKeep <survivorKey>: <title>\nTrash <loserKeys>`, plus the eligible and skipped counts.
  - Groups are merged one at a time, each in its own native transaction. The first failure stops the run, and earlier groups stay merged.
  - Shutdown (lifecycle++) stops the next group, but a native merge already running finishes.
  - Final alerts report the counts.
- Undo and reversibility: the plugin writes no merge record of its own. It relies on Zotero's native undo; the native fixture checks `Zotero.UndoHistory.canUndo()` and `undo()`, which restores the trashed record, the child note's parent and the filled field. README: "Reversing trash alone is not a complete merge undo."

3.6 argus-one tests (tests/argus.test.cjs)
- Normalisation: "https://DX.DOI.org/10.1234/Example." → "10.1234/example."; " DOI: 10.1234/A;B " → "10.1234/a;b". These give null: 10.x/a, 10.12/a, trailing text, an example.org URL.
- An ambiguous Extra (two DOIs) gives null. A bad dedicated DOI with a valid Extra DOI gives null.
- These Extra values give null: trailing text; one valid line plus one invalid line; an empty DOI line. "10.1234/a" with "10.1234/A" gives "10.1234/a".
- Discovery excludes other libraries, deleted items, non-top-level items and non-regular items; the group is [1, 2].
- Impossible dates throw /invalid dateAdded/; a leap day is accepted.
- The plan is read-only; on a dateAdded tie the higher id survives; a different item type is skipped; a different library throws /incompatible/.
- The native merge receives the newest title, the filled publicationTitle "Journal" and the creators. The survivor is the newest item, the loser is the older one, and the older one is deleted.
- Numeric 0 is kept (volume 0 stays) and can fill an empty field (issue 0).
- If setCreators throws: no merge, survivor reloaded once.
- A changed title, an added attachment, or a dirty item after the plan: rejected, no merge.
- An active transaction: /busy/, no merge.
- If setField throws: no merge, reloaded.
- The 2nd group failing: 2 calls; 4 reloaded, 3 not deleted; the alert says "1 groups completed … Completed groups remain merged"; the lock is released.
- Cancelling the preview makes no changes, and the preview contains "Keep ITEM0002". A concurrent entry gets "already running".
- The compatibility fallback (`Zotero.Items.merge`) is used.
- After a native failure, the attachment, annotation and note parents are restored, and the relation index is rebuilt to the original entry.
- A dirty child note blocks the merge. A failed reload makes later merges throw /Restart Zotero/.
- Shutdown during loading (with or without re-init) gives /disabled/, no writes.
- Shutdown during a native merge: that merge finishes, the next group does not start, and the alert says disabled / 1 completed.
- Plans are frozen; mutating the caller's copy during awaits does not change survivor or loser.
- `inTransaction` is preferred, called with the right `this`, and checked twice.
- Either API reporting busy is refused.
- Undefined, false, `()=>undefined` and `()=>0` all fail closed with /transaction state/.

tests/native/fixture.js: one plan; the preview does not mutate; the newest item survives; the older is trashed; volume 7 is filled while the title is kept; the child note moves to the survivor; tags are unioned; undo exists and restores everything.
Python tests are build and update-manifest only.

======================================================================
4. THINGS I WAS UNSURE ABOUT
======================================================================
1. "Adaptive rate limiting": the code has none beyond rates set by key presence and bounded retries. If you expected an adaptive algorithm, it is not in this source or its history notes. The README's "adapts its request pacing automatically" means only that the rate depends on which keys are set.
2. `_getSourcePriority` fallback order (crossref,pubmed,semanticscholar,openalex) differs from the default pref. It only applies if the pref is empty. Decide whether to keep this for parity.
3. Provenance-only change: if the DOI was found by title search but nothing else changed, Extra is set in memory but `changes` is empty, so there is no save, no tag, and the status is "unchanged". Probably unintended.
4. The "Citations" and "OpenAlex 2yr mean citedness" lines are dated, so every run on a new UTC day counts as an update and re-tags the item, even in fill mode.
5. "fill" vs "overwrite": standard fields treat any value other than "fill" as overwrite. Creators only change in exact "overwrite".
6. Per-source queues run requests one at a time and hold during retry waits, so throughput can be lower than the stated rps. Also, `q.last` is set when a request starts, not when it ends.
7. The OpenAlex DOI path percent-encodes "/" (encodeURIComponent). The PubMed esearch term leaves "[DOI]" unencoded. Exact URL strings matter for parity fixtures.
8. attaclone `_pickKeeper` uses Date.parse on "YYYY-MM-DD HH:MM:SS", which engines read as local time. The order is still consistent within one run. argus compares dateAdded as strings instead.
9. Argus-one: Zotero's native merge behaviour is outside this code. Recueil will need its own spec for: union of collections, tags and relations; attachment merging by PDF fingerprint or web title; keeping the earliest dateAdded; "dc:replaces" relations; and undo. The docs describe this from inspecting Zotero's source; the plugin does not implement it.
10. The attaclone note-reference check is a substring LIKE match of the 8-character key against every note in the library, including trashed notes. It can give false positives; that is deliberate.
11. The metadata-mender README table says identifiers are "Append once", but the code replaces conflicting Extra values in overwrite mode and moves them to native fields when the item type has one.
12. The metadata-mender audit counts tests as 52 Node and 4 Python; I did not run the suites, so counts come from the docs and my reading of the files.```
