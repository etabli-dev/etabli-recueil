# apps/connector

Recueil's own browser connector (CONCEPT.md Phase 8): one click saves the scholarly page you are
reading — and its PDF, when the page links one you can open — to your own Recueil server.

- **What it reads.** Highwire `citation_*` tags (what Google Scholar indexes and nearly every
  publisher and repository emits), then Dublin Core, JSON-LD `ScholarlyArticle`/`Book`, Open Graph,
  and a DOI in the address or the page (`src/extract.ts`). It does not run Zotero translators.
- **What it sends.** `POST /api/v1/items` with the metadata and inline creators, then the PDF as
  `POST /api/v1/documents` attached to that item in the same request. A token with `items:write`
  and `documents:write`, kept in the extension's local storage.
- **Permissions.** `activeTab`, `scripting` and `storage`; the host permission for your server is
  asked for when you save the settings, and for nothing else.

## Build

```sh
pnpm --filter @recueil/connector run build   # dist/chrome and dist/firefox
pnpm --filter @recueil/connector test
```

Load `dist/chrome` as an unpacked extension (chrome://extensions, developer mode) or
`dist/firefox/manifest.json` as a temporary add-on (about:debugging). For Safari, on a Mac:
`xcrun safari-web-extension-converter apps/connector/dist/chrome --app-name "Recueil connector"`,
then build the generated Xcode project.

## Status

Built and tested in CI. **Not listed in any store yet**: the Phase 8 exit ("listed in the Chrome
Web Store") needs the owner's developer accounts for the Chrome Web Store, AMO and the App Store.
