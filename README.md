# agentrail-cli

The Agentrail command line. Sign in once, then use every Agentrail tool —
competitors, prompts, evaluations, simulation runs, the Brand Vault — from a
terminal or from an AI coding agent.

Production is the default. To use the separate dev environment, pass
`--env dev` or set `AGENTRAIL_ENV=dev`.

## Use

```sh
npm install -g agentrail-cli@latest
agentrail login              # sign in in your browser
agentrail org use            # act in another of your organizations
agentrail workspace use      # and in one of its workspaces
agentrail tools              # every command your role can use
agentrail competitors list
agentrail agent setup        # Claude Code, Codex and Cursor
agentrail doctor             # what is missing, and how to fix it
```

From a clone of this repository: `pnpm install && pnpm build`, then
`node dist/cli.js login`.

The package installs one command, `agentrail`. Never install a package named
just `agentrail`: it belongs to someone else.

- **Commands come from Agentrail.** `agentrail <area> <action>` runs an
  Agentrail tool, and its inputs are flags (`--limit 5`, `--needs-attention`).
  Lists and objects take JSON (`--tag-ids '["…"]'`), and `--input` or
  `--input-file` passes a whole input. `agentrail tools` lists them all, and a
  tool Agentrail adds works without updating the CLI.
- **Organization.** Commands act in one organization at a time: the one you
  approved at `agentrail login`, until `agentrail org use <id or name>`
  switches to another of yours. Each organization gets a sign-in of its own,
  made from your browser sign-in without a browser; switching back to one
  the CLI keeps asks Agentrail nothing. `agentrail org current` names it, and
  an organization whose Admins turned agent access off cannot be chosen.
- **Workspace.** Commands use `--workspace <id>`, then `AGENTRAIL_WORKSPACE`,
  then the workspace `agentrail link <id>` recorded for the directory, then
  the one `agentrail workspace use` chose for the organization, then your
  default workspace. `agentrail workspace current` shows which, and why.
- **Output.** A table in a terminal; JSON when output is not a terminal, with
  `--json`, or inside a coding agent. Data goes to stdout, messages to stderr.
- **Agents.** Without a terminal, `agentrail login` prints the sign-in URL
  and code as JSON; run it again once the person has confirmed the code.
- **Coding agents.** `agentrail agent setup` installs the Agentrail skill and
  adds the Agentrail MCP server to Claude Code, Codex and Cursor for every
  project of yours (`--project` for this repository only, `--only` to pick
  agents, `--read-only` for the server that only reads). Each agent signs in
  to the server itself. In Claude Code you can also run
  `/plugin marketplace add agentrail-co/agentrail-cli`, and any agent that
  reads Agent Skills can use `npx skills add agentrail-co/agentrail-cli`.
- **Updates.** `agentrail update` shows the newest version and how to install
  it. Commands check npm at most once a day and say so on stderr;
  `--no-update-check` or `AGENTRAIL_NO_UPDATE_CHECK=1` turns that off.
- **Credentials** are kept in the OS keychain. `login --insecure-storage`
  keeps them in a file only you can read instead; where the keychain cannot
  keep a sign-in, the CLI says so and never falls back to a file on its own.
  There is one sign-in for each organization you use. `logout` ends each at
  Agentrail and removes them from both places. A token in
  `AGENTRAIL_TOKEN` is used as given, wins over a stored sign-in, and is
  never stored.
- **What Agentrail is told.** Each request to Agentrail names the command
  that ran (by its words, never its inputs), the run, and the coding agent
  running it, with that agent's session as a one-way hash, so Agentrail can
  join an agent's runs into one journey. It goes only to Agentrail's own
  servers, through [`agentrail-cli-sdk`](https://www.npmjs.com/package/agentrail-cli-sdk).
  `DO_NOT_TRACK=1` turns it off; `AGENTRAIL_CLI_DEBUG=1` prints it to
  stderr.

## Exit codes

| Code | Meaning                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------ |
| 0    | Done                                                                                                         |
| 1    | Agentrail refused: not found, not allowed, or invalid input                                                  |
| 2    | The command line, or a file of yours it reads, is wrong; or this CLI is too old: the message says what to do |
| 3    | Not signed in, or the sign-in expired: run `agentrail login`                                                 |
| 4    | Agentrail, the npm registry or the network could not be reached                                              |
| 5    | The CLI failed in a way it does not know: the message shows the failure in full; please report it            |

## Releasing

Bump `version` in `package.json` and `.claude-plugin/plugin.json` together,
merge, then push the tag `v<version>`. The Release workflow publishes it to
npm with provenance once the `npm` environment's reviewer approves: a
pre-release such as `0.1.0-dev.2` under `next`, a release under `latest`.

The npm trusted publisher must name GitHub owner `agentrail-co`, repository
`agentrail-cli`, workflow `release.yml`, and environment `npm`. The package's
repository URL must match that repository for provenance.

## License

Apache-2.0
