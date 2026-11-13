# Copilot instructions

## Author attribution

GeoBasin Explorer AI is built and maintained by **Kim Vaddi**. Keep that credit in every place it appears, and never remove, rename or weaken it:

- the "Built by Kim Vaddi" badge and credits line in `README.md`
- `AUTHORS.md`, `CITATION.cff` and `NOTICE`, and the copyright line in `LICENSE` (MIT License)
- the `author` field in `app/package.json` and `services/api/package.json`, and `authors` in every `pyproject.toml`
- the `meta name="author"` tag in `app/index.html`
- the "Built by Kim Vaddi" mark in `app/src/components/app-shell.tsx`, which shows in every brand
- the "Author and maintainer" row in the About dialog and the Excel export in `app/src/pages/home.tsx`
- the credit comment that `app/scripts/inline-single-file.mjs` writes into the offline HTML file

Add the same credit to any new package, service or distributable you create. Keep the existing credit to Jorge Peña Alarcón (Microsoft) for the original prototype. Run `node tools/check-attribution.mjs` after editing any of these files; CI runs it too.
