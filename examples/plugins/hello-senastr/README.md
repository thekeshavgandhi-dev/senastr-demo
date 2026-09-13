# hello-senastr

A sample senastr plugin. senastr v0 plugins are **declarative**: a
`senastr.plugin.json` manifest plus optional shell-command tool templates.
No code is loaded into the host process — each tool runs through the same
project-confined, permission-gated shell as the builtin tools.

## Tools

- `greet` — prints a greeting for `{name}`
- `file_count` — counts files in the project

## Install

From the desktop: Settings → Plugins → enter the folder path
(`examples/plugins/hello-senastr`) → Install.

Or headless:

```sh
node -e "require('node:child_process')" # not needed — see scripts/demo.mjs step 8
pnpm demo
```

> **Placeholder quoting rule:** `{arg}` placeholders are substituted with
> shell-quoted values, so *never* wrap them in your own quotes in the command
> template. `echo Hello, {name}!` is correct; `echo 'Hello, {name}!'` is not —
> the nested quotes break as soon as the value contains a quote or a space
> at an unexpected spot.

## Manifest format

```json
{
  "name": "kebab-case-slug",        // required
  "version": "0.1.0",               // required, semver-ish
  "description": "optional",
  "author": "optional",
  "permissions": { "fs": ["read"], "net": [] },
  "tools": [
    {
      "name": "snake_case_name",    // must not collide with builtin tools
      "description": "shown to the model",
      "command": "echo hi {name}",  // {arg} placeholders are shell-quoted
      "args": { "type": "object", "properties": { "name": { "type": "string" } } }
    }
  ]
}
```
