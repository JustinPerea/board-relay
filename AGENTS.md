# Setting up board-relay for someone

This file is for a coding agent that was handed this repo and asked to set it up ("set this up for me", "connect my agents to the board"). If you are here to change the code, read [ARCHITECTURE.md](ARCHITECTURE.md) instead and skip this file.

The goal: a `vb serve` board running on the person's machine, `board-relay.json` written for the agents they use, the relay running, and one test per agent that shows it can be reached. Read the [README](README.md) first, then [docs/reference.md](docs/reference.md) (its Terms, Wakes and Commands sections define what this file uses), then [docs/recipes.md](docs/recipes.md) for each tool you connect. Run `board-relay` as `node bin/board-relay.mjs` from this repo unless the person agreed to `npm link`.

## Ask before you do any of these

Stop and ask the person, say what it does and what it costs, and wait for a yes:

- **A sign-in** to any tool or service. Never run a login command for them, and never open a credential or config file to see whether they are signed in (see "Find the tools" for the status commands).
- **Anything that starts a model turn**: `board-relay ping` for a Claude Code session, a command agent that calls a model, or a webhook; turning a wake on (`"enabled": true`); a reply on the board that would wake a tool. Each one spends from the person's plan. The example `scribe` agent calls no model and is free to ping.
- **A service install**: a launchd plist, a systemd unit, a login item.
- **A global install or link**: `npm link`, `npm install -g`.
- **Writing outside this repo**: `~/.config/board-relay/`, a script in a folder on PATH, a tool's permission file or rules file in another project (`.cursor/cli.json`, `.devin/config.json`, that project's `AGENTS.md`), a shell profile.
- **`board-relay theme apply`**, which patches the installed `@vercel/board` bundle.
- **A webhook URL or key.** The person copies these into the config and the headers file themselves. Don't ask them to paste a key into the chat.
- **A bypass mode** for any tool (`--force`, `--yolo`, `--dangerously-*`, Devin's `dangerous`). Don't propose one for a wake.

If a command or permission is refused, stop and tell the person. Don't work around it.

## 1. Check the basics

```bash
node --version        # 22.18 or later
git --version
npm install           # in this repo; installs @vercel/board, the only dependency
npm test              # optional; starts throwaway boards on free ports
```

## 2. Find the tools

See which tools are installed, without starting any of them:

```bash
command -v claude cursor-agent devin codex hermes
ls -d "/Applications/Grok Bot.app" 2>/dev/null     # Grok Bot, a desktop app (macOS)
```

For each one found, check whether it is signed in with its own status command, which starts no model turn:

| Tool | Status command |
| --- | --- |
| Claude Code | `claude auth status` |
| Cursor CLI | `cursor-agent status` |
| Devin CLI | `devin auth status` |
| Hermes | `hermes status` |
| Codex CLI, Grok Bot | No known status command: ask the person |

Report what you found: installed and signed in, installed but not signed in, not installed. Ask which of them the person wants on the board, and which project folder each one works in.

## 3. Write the config

Copy `board-relay.example.json` to `board-relay.json` in this repo and edit it:

- `owner`: the person's name, as pings should say it. Add other names they go by to `ownerNames`.
- `agents`: keep `scribe` (the example agent) for the first test. Add an entry for each tool the person chose, copied from its recipe in [docs/recipes.md](docs/recipes.md), with its `cwd` set to that tool's project folder. Keep every tool's wake at `"enabled": false` for now.
- Remove the example entries (`lead`, `codex`, `cloudbot`) the person doesn't use, and the example top-level `pin`, which is for `cloudbot`. For a tool that has a recipe, replace its example entry with the recipe's. A pin is for a tool whose commands run without any permission prompt, such as Grok Bot, whose recipe brings its own. Cursor and Devin are limited by the permission rules in their recipes instead.
- `board`: keep `http://127.0.0.1:4100/api/board` unless port 4100 is taken (`lsof -nP -iTCP:4100 -sTCP:LISTEN` prints a line). Then pick a free port and use it here and in step 4.
- `fallback`: the agent told about posts that name no agent and about pings that couldn't be delivered. A session agent the person keeps open, or `scribe` while testing.
- `agentCommand`: how pings tell agents to run agent-board. The recipes' permission rules (`Shell(agent-board)`, `Exec(agent-board --as devin)`) and the line that tells a tool its name also assume `agent-board` is a command on PATH. If the person said no to `npm link`, ask whether you may put a one-line script named `agent-board` in a folder on their PATH (`#!/bin/sh` and `exec node <absolute path to this repo>/bin/agent-board.mjs "$@"`). If that's a no too, set `agentCommand` to `node <absolute path to this repo>/bin/agent-board.mjs` and use that wherever the docs say `agent-board`. Cursor's `Shell(...)` rule matches only the first word, so its rule would then have to allow every `node` command: tell the person.

Then:

```bash
node bin/board-relay.mjs check    # each agent and how it will be woken; fix every error and warning it prints
```

## 4. Start the board and the relay

Not as a service unless the person said yes. If you can't open terminals the person can see, start the board and the relay in the background, send each one's output to a log file in this repo, and record their process ids.

```bash
npx vb serve --port 4100           # the board; data in .board/. Wait until its output says "inspector at"
node bin/board-relay.mjs setup     # once per board: channels and the decision-card schema
node bin/board-relay.mjs run       # the relay; leave it running
```

To stop them, stop the process ids you recorded. `npx` leaves a parent `npm exec` process and a child `node` process for the board; stop both. To find the board by its port, use `lsof -nP -iTCP:<port> -sTCP:LISTEN`: a plain `lsof -i :<port>` also lists the person's browser tabs that have the page open.

## 5. Test each agent

- **scribe**: `node bin/board-relay.mjs ping scribe` prints `sent to scribe`, and the relay's output says `delivered agent=scribe`. Then have the person post `@scribe hello` on the board's page (<http://127.0.0.1:4100>, or the port you chose); scribe answers in the thread. To see it without the page: `npx vb read general --url <board>` lists the channel's threads with their ids, and `npx vb read <id> --url <board>` shows one thread (`<board>` is the `board` URL from the config).
- **A Claude Code session**: `node bin/board-relay.mjs sessions` lists every Claude Code session on the machine that the relay can see, with its folder; it costs nothing, but tell the person it reads their sessions folder. A ping costs a turn: ask first, then `node bin/board-relay.mjs ping <agent>`.
- **A resume tool (Cursor, Devin, Codex, Hermes)**: `board-relay ping` can't test these, because a resume needs a thread the tool has posted in. First, with the person's yes, add the recipe's permission rule to that tool's project (`.cursor/cli.json` for Cursor, `.devin/config.json` for Devin), and the line that tells the tool its name to the project's `AGENTS.md`. Then ask the person to open a session in that tool, in its project folder. Then:
  1. In that session, the tool runs `agent-board --as <tool> session`. It should print `session=<id>`. If it prints no label, check the recipe's permission rule and session setting before going on.
  2. The tool posts once: `agent-board --as <tool> post general "<tool> is connected"`.
  3. With the person's yes, set that wake's `"enabled": true` (the relay rereads the config) and have the person reply to that post on the board. The relay resumes the session, and the tool answers in the thread. If it doesn't, the relay says why in the thread and names the log in `.board-relay/wakes/`.
- **Grok Bot**: the person makes the webhook routine in Grok Bot and writes the headers file (see the recipe). Then, with their yes, set its wake's `"enabled": true` and run `node bin/board-relay.mjs ping grok`, which calls the routine once. A ping to a wake that is turned off fails without calling anything.
- **A Devin cloud session**: nothing to ping. With the session connected, have it run `agent-board --as devin-cloud post general "connected"` (or the profile you gave it).

## 6. Report

Tell the person, per agent: connected and tested, configured but waiting on them (and for what: a sign-in, a yes to enable its wake, a webhook key), or left out. Include the commands that start the board and the relay again, with the port and config you used, and the reference's [Running it all the time](docs/reference.md#running-it-all-the-time) section if they want it to start at login.
