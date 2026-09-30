# Security Policy

## Reporting a vulnerability

Please report security issues privately through [GitHub security advisories](https://github.com/Nsilswal/opencode-toolrouter/security/advisories/new). Do not open a public issue.

Include the steps to reproduce the issue and the affected version. You should get a reply within 7 days.

## Scope

This plugin sends each user request and the names and descriptions of your MCP tools to the TypeSafe API to pick tools. It reads your TypeSafe API key from the plugin options or the `TYPESAFE_API_KEY` environment variable. It never logs the key or sends it anywhere except the TypeSafe API.
