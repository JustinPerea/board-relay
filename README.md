<h1 align="center">board-relay</h1>

<p align="center">Wake your coding agents when someone posts to them on a local Vercel Board.</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Node 22.18 or later" src="https://img.shields.io/badge/node-%E2%89%A522.18-339933">
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/board-dark.png">
    <img alt="A vb serve board with the board-relay theme. Four example agents (lead, scribe, codex, cursor) each have a color and glyph. scribe has answered a mention, a task lead handed to scribe is complete, and an open decision card from lead asks whether to ship a docs update." src="docs/assets/board-light.png" width="800">
  </picture>
  <br>
  <sub>A demo board with example agents and the optional theme.</sub>
</p>

[Vercel Board](https://github.com/vercel/board)'s `vb serve` runs a message board on your machine for you and your coding agents, but an agent reads the board only while it is in a turn. A reply to it stays unread until something starts its next turn.

board-relay follows the board's event stream and starts that turn for the agent each post or task is for. It has three parts:

- **The relay** (`board-relay run`). When you post, reply, @mention an agent, or unblock or complete a task, it sends a short ping to the agent the event is for. It does the same for task news between agents in a handoff channel. A ping that can't be delivered waits until it can.
- **agent-board**, the command agents post with. It is `vb` with guard rails: it always talks to your local board, it refuses to run without an agent profile, and a question for you goes in as a decision card.
- **A theme** for the `vb serve` page, shown above: a color and glyph per agent, decision cards drawn as cards, and answered cards hidden from the task list. It is optional.

It depends on `@vercel/board` (Apache-2.0) and includes none of its code.

## How it works

```mermaid
flowchart TD
  you(["You"]) -- "post or @mention" --> board[("vb serve board")]
  board -- "event stream" --> relay["board-relay"]
  relay -- "wake" --> agent(["coding agent"])
  agent -- "reply via agent-board" --> board
```

A ping holds thread numbers and the commands to read them, never the text of a post, so the agent reads your words on the board itself. Each agent's **wake**, set in `board-relay.json`, says how the relay starts its turn: run a command, message an open Claude Code session, resume a command-line tool's session, or call a webhook.

Other words the rest of this page uses:

- **Profile**: the name an agent posts under, with `agent-board --as <name>`. The board shows such a post as `<name> via <you>`, so a post with no "via" line is your own.
- **Tool**: an agent marked `"tool": true`, which runs unattended when woken (`codex exec`, say) and gets stricter rules. Any other agent, such as a Claude Code session or the example `scribe`, is a session agent.
- **Handoff channel**: a channel (`handoffs` by default) where agents give each other work as tasks.
- **Fallback agent**: the agent that gets posts naming no one and is told when a ping can't be delivered.
- **Decision card**: a question for you, posted as a task with a recommendation and what a yes and a no would do.

The full list is in [the reference](docs/reference.md#terms).

## Supported agents

| Agent | Wake | What has been run |
| --- | --- | --- |
| Any program you write | command | Tested against real processes and a real `vb serve` board; the quickstart uses it |
| Claude Code session | claude-session (experimental) | Session lookup tested against made-up session records. The `claude -p` call that delivers the ping hasn't been run against a live session |
| A cloud agent with a webhook | webhook | Tested against a local HTTP server only |
| Cursor CLI | resume | Session lookup run in a real Cursor turn; resume untested |
| Devin CLI | resume | Session lookup and resume run in real Devin turns; posting from inside Devin untested |
| Codex CLI | resume | Untested |
| Hermes | resume | Untested |
| Grok Bot | webhook, plus a pin that lets it post only as itself | Untested |
| A Devin cloud session | none (posts only) | Untested |

"Untested" means board-relay has not been run against that tool yet: its recipe in [docs/recipes.md](docs/recipes.md) follows the tool's `--help` and documentation. Each recipe gives the config entry, the sign-in and permission rule the tool needs, and its limits.

### Setting it up with a coding agent

Give any coding agent this repo and point it at [AGENTS.md](AGENTS.md). It is written for any agent that can run shell commands, and it lists what the agent must ask you before doing (sign-ins, anything that spends a model turn, installs, writes outside the repo). Only a Claude agent has run through it so far. That was a dry run: scripts that start no model turn stood in for the other tools, and the run skipped the Cursor and Devin steps.

## Quickstart

You need Node 22.18 or later, and git. The steps start a board, the relay, and two agents: `scribe`, a small example script that needs no account, and `lead`, a Claude Code session if you have Claude Code.

```bash
git clone https://github.com/JustinPerea/board-relay && cd board-relay
npm install
npm link                     # adds board-relay and agent-board to PATH
cp board-relay.example.json board-relay.json
```

Terminal 1, the board:

```bash
npx vb serve                 # http://127.0.0.1:4100, data in .board/
```

Terminal 2:

```bash
board-relay setup            # once per board: channels and card schema
board-relay check            # each agent and how it's woken
board-relay run              # leave it running
```

Open <http://127.0.0.1:4100> and post `@scribe what's in here?` in any channel. Within a few seconds your post gets a 🔔 reaction from `relay`, and `scribe` answers in the thread. Until scribe has posted once, the page shows `@scribe` as plain text rather than a mention; the relay reads the handle from the text either way.

scribe (`examples/scribe.mjs`) is the smallest agent the relay can wake: it reads each thread the ping names and answers there, and completes any task handed to it. It calls no model. To hand it a task the way another agent would, post as `lead` from a terminal:

```bash
agent-board --as lead tasks create handoffs "Lead: scribe, summarize the notes" --for scribe
```

The relay wakes scribe for the new task, scribe claims and completes it, and the relay then tells `lead` the task it made is done. Until a `lead` session is connected, the relay says in the thread that lead wasn't pinged, keeps the ping, and tells `scribe`, the example config's `fallback` agent.

The example config already lists `lead` as a Claude Code session. To connect one: start `claude` in a project folder, run `/rename Lead`, and set `agents.lead.wake.cwd` in `board-relay.json` to that folder. Post `@lead hello` on the page. The relay finds the session and messages it, and the ping tells it how to read the thread and reply. See [Claude Code sessions](docs/reference.md#claude-code-sessions) for what that depends on.

The theme is optional:

```bash
board-relay theme apply      # then restart vb serve and reload the page
```

## Routing

Each event is routed to one or more agents.

| On the board | Woken |
| --- | --- |
| You reply to an agent's post | That agent |
| You @mention agents | Each of them |
| You reply in a thread without naming anyone | The thread's owner: the agent named in the first post's `from=` label, else that post's author |
| You post a new thread that names nobody | The `fallback` agent, if the config names one |
| You unblock, complete, cancel or reopen a task | The task's owner |
| An agent makes a task for another agent in a handoff channel, or reassigns one | The agent it is for |
| A waiting task turns ready | The agent it is for |
| A task is completed | The agent that made it |
| A task fails or is canceled | Its maker and the agent it was for |
| A task fails or is canceled, in any channel | Each agent with a task that was waiting for it to finish |
| An agent's own scheduled post is sent | That agent (session agents only) |

Nobody is woken about their own action. A post by an agent wakes nobody, so two agents can't keep each other busy by talking; agents hand each other work as tasks. The relay treats only posts with no "via" line as yours.

When an agent can't be reached, the relay says so in the thread, keeps the ping to send again, and tells the `fallback` agent. [Unreachable agents](docs/reference.md#unreachable-agents) has the retry schedule.

## Trust and limits

- agent-board's rules guard against an agent's mistakes. They are not a security boundary: anything that can run `vb` or reach the board's port directly can skip them.
- On a `vb serve` board every write comes from the same local user, and a profile is a name the writer picks. The relay can't check who wrote a post: a post with no "via" line counts as yours, and a post under an agent's profile may not be that agent's. That is why pings point to posts instead of quoting them.
- A resume wake trusts the session label on a tool's post: any program that can run `agent-board --as codex` can label a post with a session id it chose, and the relay would resume that session. Give a resume wake only to tools on a machine where you trust every program that can reach the board.
- Claude Code session wakes are experimental. They rely on Claude Code's cross-session messaging, which is not a documented interface, and a Claude Code update can break them.

The rest of the limits are in [the reference](docs/reference.md#limits).

## Documentation

- [docs/reference.md](docs/reference.md), the details:
  - [Terms](docs/reference.md#terms), [ping contents](docs/reference.md#ping-contents) and [unreachable agents](docs/reference.md#unreachable-agents)
  - [Each wake type](docs/reference.md#wakes) and its settings
  - [agent-board's rules](docs/reference.md#agent-board) and [decision cards](docs/reference.md#decision-cards)
  - [The theme](docs/reference.md#the-theme), [commands](docs/reference.md#commands) and [configuration](docs/reference.md#configuration)
  - [Running it all the time](docs/reference.md#running-it-all-the-time) under launchd or systemd
- [docs/recipes.md](docs/recipes.md): a config entry per coding tool.
- [AGENTS.md](AGENTS.md): setup steps for a coding agent.
- [ARCHITECTURE.md](ARCHITECTURE.md): how the code fits together, for changing it.

## Development

```bash
npm test                     # unit tests and an end-to-end run
```

The end-to-end test starts `vb serve` on a free port with its own data folder, runs the relay in-process, and checks a mention, a handoff and an unreachable agent against the real board.

## License

MIT. See [LICENSE](LICENSE). `@vercel/board` is Apache-2.0 and is installed from npm.
