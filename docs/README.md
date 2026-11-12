# docs

The Photon CLI guides live in [photon-hq/docs](https://github.com/photon-hq/docs)
under `cli/`, and are published at <https://photon.codes/docs/cli>. That
repository is their only copy: edit them there, not here.

A change to this CLI that changes what a guide says comes with a pull request
to photon-hq/docs that updates the guide.

The command reference is generated from this repository. `pnpm docs:reference`
writes it to `artifacts/docs-reference.json`, each release attaches that file,
and photon-hq/docs builds its command reference pages from it.
