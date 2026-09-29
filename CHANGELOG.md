# Changelog

All notable changes to this project are documented here. Versions follow [semver](https://semver.org).

## 0.2.0

### Added
- `notion_undo` checks whether anything it would restore was edited after the original change, and refuses with a list of those objects (naming later journal entries when the edit came from this server). `force: true` overwrites.
- Undo now deletes comments added by automation rules.
- Block inserts that fail partway record the blocks that did land, so `notion_undo` can remove them, and the error says where to resume.
- 30-second request timeout (`NOTION_TIMEOUT_MS`). Reads retry after timeouts and dropped connections; writes don't, since the first attempt may have landed.
- ESLint (typescript-eslint strict), vitest, `npm run check`, and a CI workflow that lints, typechecks, tests, and builds on every push.
- `npm run test:live` for the live integration suite, with new steps for undo conflicts and comment undo.

### Changed
- Oversized results shrink their longest list and stay valid JSON, with a count of omitted items, instead of being cut mid-text.
- The server reports its version from package.json.
- The Notion client only logs errors, not the expected not-found fallbacks.
- README: corrected API limits that Notion has since lifted (status options, views, comment deletion, page moves).

## 0.1.0

- Initial release: surgical block edits, schema-validated property writes, bulk updates with dry run, find/replace, schema tools, undo journal, polling automations with a GitHub Actions schedule.
