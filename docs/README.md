# docs

The Recueil documentation site: a [Quarto](https://quarto.org) website, published to GitHub Pages at
<https://etabli-dev.github.io/etabli-recueil/>.

## Building it

Quarto 1.4 or newer. No R or Python is needed — every page is plain Markdown with no computed
output, so no compute engine is involved.

```sh
quarto preview docs     # live preview with reload, from the repository root
quarto render docs      # build into docs/_site
```

`_site/` and `.quarto/` are generated and are not committed.

## Pages

| File | Contents |
|---|---|
| `index.qmd` | Landing page: one-liner, tagline, honest status, where to go next |
| `getting-started.qmd` | What installation and first use will look like |
| `concepts.qmd` | Documents vs items vs attachments, content-hash identity, facets, provenance |
| `self-hosting.qmd` | Deployment shapes, configuration, storage, TLS, tokens, backup |
| `api.qmd` | REST contract, MCP, analytics export, language clients |
| `cli.qmd` | The `recueil` command surface |
| `plugins.qmd` | Extension surfaces, manifest, hook catalogue, SDK |
| `roadmap.qmd` | Summary of CONCEPT.md §7 |
| `adr.qmd` | Index of the decision records in `spec/adr/` |
| `contributing.qmd` | Summary of CONTRIBUTING.md |

`_quarto.yml` holds the project, navigation and theme configuration: `cosmo` for light, `darkly` for
dark, with `repo-actions` pointing at this subdirectory so every page has a working edit link.

## Conventions

- **British English**, matching `CONCEPT.md` and the ADRs.
- **Nothing is described as working when it is not.** Every page that documents unimplemented
  behaviour says so at the top and names the roadmap phase that delivers it. Phases 1 and 2 are in
  the tree, so the pages covering the library, the API, the CLI, the importers, ingestion and
  storage now describe working software; everything from Phase 3 on is still a contract. Where a
  page mixes the two, the table says which row is which.
- Links to files outside `docs/` — `CONCEPT.md`, `spec/`, `CONTRIBUTING.md` — go to GitHub, because
  they are not part of the rendered site.
