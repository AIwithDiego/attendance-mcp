# Changelog

## Unreleased (v0.2.0)
- `npm run sample`: starts the built server over stdio, calls four tools and checks the four planted patterns rank first; output in `docs/sample-analysis.md`
- CI runs the sample analysis and a gitleaks scan of the full history
- README rewritten as a case study: the v1 internal demo, the MCP rebuild, what went wrong and how to run it
- How-it-works diagram, cover image, contributing guide, security policy, issue and PR templates

## v0.1.0 · 25 Sep 2026
- First public release: an MCP server with 7 read-only tools, a schema resource and a weekly review prompt over seeded synthetic attendance data
- 26 tests through a real MCP client; two live Claude Code sessions (19 and 87 calls) found 5 bugs, 4 rough edges and 1 missing tool, all fixed with regression tests
