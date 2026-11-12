# docs

Public Photon CLI documentation, authored here next to the code and rendered by
the [photon-hq/docs-v2](https://github.com/photon-hq/docs-v2) aggregator. The
docs repo pulls this directory from the `main` branch, runs
[vellum](https://github.com/photon-hq/vellum) to render `.mdx.vel` → `.mdx`, and
merges `nav.json` into the site navigation.

- **Edit pages here** (`*.mdx.vel`). They are Mintlify MDX; the `.vel` extension
  is what makes the aggregator's build pick them up.
- **`nav.json`** is this repo's slice of the site navigation — the groups
  docs-v2 merges into the **CLI** tab. Every slug is mount-prefixed with `cli/`,
  and every slug must have a matching page or the aggregator build fails.
- Pages are built **centrally** in the docs repo. To preview locally, point
  docs-v2 at this directory:
  `DOCS_SOURCE_MODE=local pnpm docs:generate && npx mint dev`.
- Internal engineering notes go in [`../notes`](../notes), not here — this whole
  directory is copied into the public site.
