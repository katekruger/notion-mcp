# Support policy

## What's supported

| | Supported | Notes |
|---|---|---|
| Node.js | 22 and 24 | Node 20 reached end of life in April 2026. CI runs every check on 22 and 24. Bundles run on the host's built-in Node. |
| Notion API version | 2026-03-11 | Pinned. `NOTION_VERSION` overrides it, unsupported: `notion_doctor` warns when it's set. |
| Hosts | Claude Desktop, Cowork (MCP Bundle), Claude Code (from source) | Any MCP client over stdio should work. |
| Bundle platforms | macOS (Apple silicon, Intel), Windows x64, Linux x64 | Built and install-tested by the release workflow. |
| Automation runners | Local (`npm run automations`), GitHub Actions, webhook mode (`npm run webhook` or the Docker image) | Webhook mode needs HTTPS in front of it (a reverse proxy or tunnel). |

## Versions and deprecations

- Versions follow [semver](https://semver.org). From 1.0, the stable surface is the tool names and arguments, the result envelope (`status`, `summary`, `data`, `warnings`, `undo`, `pagination`, `next_actions`), the rule and workflow spec formats, the template format, the environment variables, and the local state files. Breaking any of them needs a new major version. The [changelog](CHANGELOG.md) lists every change, with upgrade notes when something moves.
- Anything removed or renamed (a tool, an argument, a setting, a result field) keeps working for at least one minor version first, with a warning in its results or log. Example: `--max-writes` still works as the old name of `--max-rows`.
- Local state files are upgraded in place when their format changes, and older versions' files are read and moved, never discarded.
- Only the latest minor version of the latest major gets fixes. Security fixes also go to the last minor of the previous major for six months after a new major.

## Reporting problems

Open an issue with the output of `notion_doctor` (it never includes the token), the tool and arguments that failed, and the error text. For security problems, use GitHub's private vulnerability reporting instead of a public issue.
