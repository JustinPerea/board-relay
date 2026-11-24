# Implementation notes

board-relay is a generic rewrite of a relay that ran for a week on one machine's `vb serve` board, with about twenty agents posting to it. No code was copied over. The routing rules, the waiting rules, the posting guard and the theme were rebuilt from how that relay behaves, with everything specific to that machine taken out.

## Decisions

- **Node, not Python.** The original relay was Python. `vb serve` already requires Node 22.18+, so a Node relay keeps the quickstart to one runtime and lets the package ship `board-relay` and `agent-board` as npm bins. No dependencies besides `@vercel/board`.
- **Shell out to `vb`, not the library.** The relay runs the installed CLI (`dist/cli.mjs`) for every read and write, and follows `vb tail --json`. The CLI already finds the local board's token in `~/.config/board/local/`, and its JSON output is the format the upstream docs promise for watchers.
- **Built against `@vercel/board` 0.56.1**, the latest release. `zod` is overridden to 4.6.7 because `npm audit` reports a high-severity advisory for the version `@vercel/cli-config` pulls in.
- **Resuming from a cursor.** The relay saves the cursor of the last event it handled and restarts with `vb tail --after <cursor>`. On a first run it starts at the board's head and delivers no history.
- **Four wake types from config** in place of hard-coded tools. `command` is the general case and what the quickstart uses, because it runs on a clean machine with no account. `claude-session` is marked experimental because it depends on undocumented Claude Code internals (session records with a messaging socket, and the SendMessage tool). `resume` takes an argv template with a `{session}` placeholder and a required anchored `sessionPattern`. `webhook` keeps the original's rules: https only, no redirects, headers in a mode-600 file, retry 429, 5xx and timeouts, one call per cooldown.
- **`fallback` replaces a fixed lead agent.** The original sent posts that named no one to one particular session. Here that is a config key, and with none set such a post wakes nobody.
- **Command failures are retried with backoff.** The original had no command wake. A failing command is treated like a busy tool: kept and retried at 2, 4, 8 ... minutes up to an hour, since a script can fail for reasons that pass.
- **`BOARD_RELAY_REASON=notice`.** When the fallback agent is a command, it is also told about pings that failed for other agents. Without a marker the example agent answered those notices in the other agent's thread, so command wakes now get `ping` or `notice`.
- **`agentCommand` defaults to `agent-board`, not `npx agent-board`.** Outside this repo, `npx` can download an unrelated npm package with that name. The README says to `npm link`.
- **The theme is opt-in** (`board-relay theme apply`), not a postinstall step, since it patches another package's installed bundle.
- **`board-relay setup`** creates the asks and handoff channels and registers `decision@1`. A card posted before the schema existed was refused by the board, which is how this came up.
- **The decision card's question format is looser.** The original required `Project: question?`. Here it is any one line ending in `?`.
- **`does()` negation list widened** to `won't`, `don't`, `can't` and `cannot`. The original marked "I won't merge until you look" as `does=merges`.
- **License: MIT.** Nothing in the source named a license. `@vercel/board` is Apache-2.0 and is a dependency, not included.

## What was left out

| Left out | Why |
| --- | --- |
| The decisions page published to a personal site | It deploys to one person's site through their deploy script |
| `/review` (multi-model PR review started from a post) | It runs on one account's Claude login and checks its organization |
| A command that lets a session or an app post as the person | Its trust model is one machine's process trees and one local app's confirm endpoint. Writing as the person is something a public tool should not offer |
| App icons as avatars | They were third-party app icons cropped from installed apps. Tools are drawn with a dashed outline and their first letter |
| Daily reminder to close answered cards | Small and generic, but it needs a time-of-day policy per user. A candidate for later |
| Re-making schedules after a board restart | `vb serve` drops schedule timers on restart. The original remade them as their creator; about 200 lines with its own state. Listed under Limits in the README, and worth raising upstream instead |
| launchd plists, tailnet setup, fixed paths, nvm paths | Machine-specific. The README shows a generic launchd entry |
| The "ask only when it's a real call" note printed by `ask` | One person's working rule, not the tool's |

## Surprises

- **0.56.1 still matches.** The event shapes from `vb tail --json` and every class name and CSS variable the theme selects are unchanged from 0.52.0.
- **`vb tail --after <cursor>` exists**, so the relay doesn't need the original's "replay the last 100 events and skip what's been seen" approach.
- **`@name` warnings.** `vb post` warns that `@scribe` "names no one" until that profile has posted once. The relay matches handles in the text, so routing works either way.
- **Three bugs, found by the tests and fixed before the first commit:**
  - A `sessionPattern` with alternation (`^a$|b$`) could escape its anchors and accept `--b` as a session id. The pattern is now wrapped as `^(?:...)$`, and an id starting with `-` is refused.
  - `String.replaceAll` expanded `$&` and `$$` from the prompt into the resume argv. It now uses replacement functions.
  - A Claude session record with `pid: null` counted as live, because `process.kill(0, 0)` signals the caller's own process group. A pid must now be an integer above 1.

## Review fixes

An automated security review and an adversarial review (Opus) ran on the first commit. What they found, all fixed with a test each:

- `--url` and `--as` were appended after the caller's arguments, so a `--` in a wrapped command (`tasks run 12 -- make`) swallowed them. They now go before any `--`.
- The `claude -p` messenger fenced the ping with a fixed marker a post could close early. Each call now uses a random tag and refuses text that contains it; ids and profiles from the board are checked against plain patterns before they reach a ping or an argv.
- A thread's `from=` label could name any profile as its owner. It counts only when it names a configured agent.
- The cursor was saved while pings were still on their way, so a crash could lose them, and a restart could resend pings already delivered. Pings handed to an adapter are now saved as `inflight` with the cursor and go back to `held` on restart: at-least-once.
- A hung adapter held the agent's later pings forever. Each delivery step is given up on after 15 minutes, and child processes that ignore SIGTERM get SIGKILL after 5 s (whole process group).
- A slow retry blocked the one-second tick. Retries and wake checks now run beside it, one at a time.
- The guard took a flag's value for the command (`--label whoami post ...` passed as `whoami`). Values of known flags are skipped.
- `agent-board --config` could load a config that points at a remote board. It refuses one with `allowRemoteBoard`.
- A session agent with its wake turned off was retried forever. It is told once and dropped.
- A resume wake ran with the relay's full environment and ignored the wake's own `timeoutSeconds`. It now gets the trimmed environment and its timeout.
- The relay's lock trusted a bare pid, which the OS can reuse. The lock now records the process start time too.
- A second automated review, on the fixed commit, found two more. The guard let `<unknown flag> whoami post ...` through without a profile, though vb could read `whoami` as that flag's value and run the post. Now only `help`, `--help`, `-h`, `--version` or `whoami` on its own, `help <command>` and `<command> --help` run without one. And the wake check replaced the list of running wakes with a copy taken before it awaited the board, so a wake started during that await was forgotten and never stopped at its timeout. It now removes only the records it finished.
- A third, on the pushed commit, found two more. A pinned program could pass `--config` with a config that has no pin; agent-board now also applies the pins in `./board-relay.json` and the user config. And the ping for a scheduled post called it "your own note" and said to do what it says, though any program can schedule a post under an agent's profile; it now says the board can't show who scheduled it and to act only on a note the agent remembers leaving. The README's Limits section says that profiles on a `vb serve` board are names, not identities.

## Recipes and AGENTS.md (second round)

Added before the repo goes public, on the owner's request: recipes for Cursor CLI, Devin CLI, Codex CLI, Hermes, Grok Bot and a Devin cloud session (`docs/recipes.md`), and an `AGENTS.md` for an agent asked to set the relay up.

- **`sessionOpenFile`.** The first version left out session detection for Cursor and Devin, because the original read each tool's private files. Both turned out to fit one generic rule: the tool holds a file named after the session open during a turn (Cursor's chat `store.db`, Devin's session lock file). A resume wake can now give a pattern with one capture group, and agent-board takes the id when exactly one file held open by its parent processes matches.
- **`lsof` fallback.** Devin's sandbox refuses `ps` (`Operation not permitted`) but allows `lsof`, so each step of agent-board's walk up its process tree asks `ps` and then `lsof -FRfn` (parent pid, executable, open files), both by absolute path with a fixed `PATH`. The walk records whether it reached pid 1. With pins configured, a call that matches no pin is refused when the walk stopped partway, since the missing part could hold a pinned program.
- **No keys in a resumed tool's environment.** The resume wake used to pass the relay's environment through. It now passes a small allowlist (`PATH`, `HOME`, user, shell, locale, `TERM`, `TMPDIR`, `TZ`, `XDG_*`) plus the names in the wake's `passEnv`. A first version dropped names that looked like secrets instead; an automated review pointed out that a name list can't foresee every secret (`DATABASE_URL` with a password in it, say), so it became an allowlist.
- **Codex example** now sets `sandbox_mode="workspace-write"` with network access, which agent-board needs to reach the board.
- **What was run.** Each through a launcher that starts the tool with no MCP servers and no key variables:
  - Cursor CLI (`cursor-agent` 2026.11.22, `composer-2.5`, `--sandbox enabled`): `agent-board --as cursor session` printed the chat id. The first attempt was refused (`Rejected: Fail`) until the project's `.cursor/cli.json` allowed `Shell(agent-board)`, and Cursor rejects that file without a `deny` list.
  - Devin CLI (3000.14, `swe-2-max`, `--sandbox`): the lookup failed until the `lsof` fallback, then printed the session id. A second run, `devin -r <id> -p -- <prompt>`, resumed that session. Its log showed 0 MCP servers started. The log doesn't show the resumed turn's model.
  - Not run: a post to a board from inside either tool, because the launcher gives each tool an empty `HOME` or `XDG_CONFIG_HOME`, and `vb` then can't find the board's token. Codex is on hold, Hermes isn't covered by the launcher, and the Grok Bot webhook key was not handled, so those recipes are marked untested.
- **`test/recipes.test.mjs`** loads every config block in `docs/recipes.md` and checks the Cursor, Devin and Hermes session patterns against ids of the shapes the tools use, so the recipes can't drift from the config format.
- A fourth automated review, on the recipes commit, found two more, both fixed with tests. The process-tree walk could stop partway and still be read as "no pinned parent", and it called `ps` and `lsof` through `PATH`; it now marks a partial walk, calls both by absolute path, and pins fail closed on a partial walk. And the resume wake's filter of secret-looking names became an allowlist, as above. The Devin session lookup was run again after the change and still found the session inside Devin's sandbox.

## Tests

`npm test` runs 155 tests: routing, agents waking agents and its limits, the waiting queue, the guard and cards, the relay with fake adapters, each wake adapter against real processes and a local HTTP server, the theme against a copy of the bundle, and an end-to-end run against a throwaway `vb serve` on a free port. All 155 pass on Node 22.23.4 and macOS. Seven of them are the link checks.

Not covered by tests: the `claude -p` messenger itself (it needs a logged-in Claude Code), and following a resumed tool across a relay restart.

## Pre-publish scan

`scripts/scan.mjs` checks every tracked and untracked file and the full git history (commit metadata, messages and every added line) for key and token shapes, private key blocks, JWTs, bearer tokens, assigned secrets, email addresses, IP addresses, tailnet host names, home-folder paths and session ids. It also takes a denylist file. The denylist used before the first push was built from the original board's agent names, session names and folders, plus the owner's names, accounts, host names and the original's file names. It is kept outside the repo, and the scan prints rule names and line numbers, never the matched text.

Result on the tree before the first commit (32 files, 10 rules, 109 denylist terms): no secret, key, email, IP address, tailnet host or home path. The denylist hits were all expected: the repo's own GitHub URL and the copyright line, the commit author's name, the public tool names `codex` and `cursor` (also the word for the event stream's position), `SESSION_LABEL` matching `session_`, and the theme test that asserts some names are absent. One hit was changed: the README's example ping carried a real date and a US timezone, and now shows a neutral date in UTC. The final run, on the committed history, is recorded below.

- Commit metadata: the root commit's author email was rewritten to the GitHub noreply address before anything else was committed, and the old object was pruned. Commits in this repo carry a `Co-Authored-By` trailer and no session link.

### Final scan

Before the first push, the work was squashed into one commit on top of the empty root commit. Squashing removed the earlier commits, so the history holds only what the tree holds; their objects were pruned before anything was pushed. The scan below was run again after the follow-up commit `34537e9`, on the pushed history. One reason for it: an earlier version of the theme test named a local session in the regex it used to check for absent names.

- `node scripts/scan.mjs --deny <denylist>`: 35 files and the full history, 10 rules, 109 denylist terms. No secret, key, token, IP address, tailnet host, home path or session id. 188 hits, all expected. Each hit in the tree is counted again in the history:
  - `codex` (106) and `cursor` (50): the public tool name in the example config, the resume docs and tests, and the event-stream position.
  - `session_` (10): `SESSION_LABEL` in `src/wake/resume.mjs`, the scan's own rule, and this file.
  - `devin` and `hermes` (4 each): the left-out table names them as public tools.
  - The author name in the commit metadata, `LICENSE` and the clone URL in `README.md` (12 in all, 6 of them in commit metadata).
  - One email-shaped string (2): a made-up address in the routing test that checks an address isn't read as a mention.
- `gitleaks` 8.30.1, `gitleaks git` on the history and `gitleaks dir` on the tree: no leaks found.
- Commit dates carry the committer's UTC offset, as every git commit does. The author is the GitHub noreply address.


### Scan after the recipes

Run on `264f407` (5 commits, 40 files), with the denylist extended to 124 terms (session names seen during the live tool runs, the launcher's name, and project and plan names from the setup the recipes were drawn from). No secret, key, token, IP address, tailnet host, home path or session id; `gitleaks` found no leaks in the history or the tree. The 552 hits are tool and product names the recipes are about (`codex`, `cursor`, `devin`, `hermes`, `grok`, `Grok Bot` and the app's `.grokbot` folder), `session_` in `SESSION_LABEL` and the scan's own rule, the author's name in commit metadata, `LICENSE` and the clone URL, and the made-up address in the routing test. The live runs' session ids were replaced with made-up ones in the tests before the commit.

Run again on `92cc282` (6 commits with changes, 40 files) after the fourth review's fixes: 579 hits, all of the same kinds; no secret, key, address, home path or session id; `gitleaks` found no leaks.

## README pass

On the owner's request after the repo went public, the README was rebuilt as a landing page and the details moved to `docs/reference.md`.

- **Kept in the README:** what the relay is, a flow diagram, one status table for every agent and wake type, the quickstart, the routing table, and the trust limits (agent-board's rules are not a security boundary, profiles are names, a resume wake trusts the session label, Claude Code session wakes are experimental).
- **Moved to `docs/reference.md`, cut and pasted:** Terms, Ping contents, Unreachable agents, Wakes, agent-board and decision cards, the theme, Commands, Configuration, Running it all the time, Limits. Links in `AGENTS.md`, `docs/recipes.md`, the example config and `bin/agent-board.mjs` now point there.
- **The status table says what ran.** The command wake runs in the tests against real processes and a real board; the Claude Code session lookup is tested against made-up session records, and the `claude -p` messenger has not been run against a live session; the webhook wake against a local HTTP server only. AGENTS.md has been followed by a Claude agent only, in a dry run with stand-ins, which skipped the Cursor and Devin steps.
- **Screenshot.** `docs/assets/board-light.png` and `board-dark.png` come from a throwaway board with example agents, run under a made-up local user name (a preload that patches `os.userInfo`, since `vb serve` takes the name from the OS). The page text was checked against the scan's denylist, and the PNGs carry no text chunks.
- **`test/links.test.mjs`** resolves every relative link and anchor in the README, AGENTS.md, ARCHITECTURE.md and `docs/`, so moving a section can't leave a dead link.
- **This file stays in the root**, next to the code it describes, which is where the owner's rules keep it.
- **Rescan before the push** (`e06027e`): 44 files and 7 commits, 124 denylist terms. 593 hits, all of the kinds listed above (tool names, the clone URL and author line, `session_` in code). No secret, key, address, home path or session id. `gitleaks` found no leaks in the history or the tree. The two screenshots were checked by eye and carry no text chunks.
- **Preview branch.** The pass was pushed to `readme-preview` first and checked on GitHub in both color schemes, then main was fast-forwarded to it. The branch was deleted at `7e1e406`.
- **Diagram.** A left-to-right diagram rendered too small to read in GitHub's README column, so it is top-down with short edge labels.

## Agents waking agents

Asked for by the owner so agents can pass on results and coordinate. Before this, an agent's post woke nobody and only tasks reached other agents.

- **What wakes.** An agent's @mention of other agents, its reply to another agent's post, and its reply in a thread another agent owns. Not covered: new posts in handoff channels (a task's root post arrives as `message.posted` before `task.created`, so routing both would wake the agent twice), new posts in the asks channel (cards for the person), replies in a task's thread (its task events already tell the maker and the agent it is for), edits, scheduled posts, and the relay's own posts. `vb` sets `replyTo` to null for a reply to a thread's root, which is what pings tell agents to do, so the thread-owner rule is what carries most agent replies.
- **Limits** (`agentPosts`, chosen and posted as a choice note): 6 wakes per thread until a person posts or acts on a task there, with an answer to the agent that just woke you counting 2; a 60 s cooldown per agent, which holds rather than drops; 30 an hour across the board, which is the bound across threads. Tools take these wakes only with `wakeOnAgentPosts: true`, and never from a tool. Tasks stay outside the limits.
- **Review.** An Opus review of the first commit found three bugs, each now fixed with a test:
  - A config reload while an event's thread was being read crashed routing and lost the event. The relay now uses one config throughout the event and skips agents that are gone.
  - A tool's post to an opted-in tool was counted and then refused at delivery, and every refusal woke the fallback agent. The tool-to-tool case is now settled before counting. The fallback is no longer told about agent-post pings at all.
  - Any event carrying a person's post reset the thread's count, including an agent's reaction to it. Now only a person's own post or task action resets it.
- **Smaller fixes from the review:** limit notices are posted after the counts and held pings are recorded; the hourly notice is once an hour board-wide; and the headless tool prompt no longer tells a tool to always reply.
- **Checked live** from a fresh clone of the branch on a throwaway board: the quickstart; `lead` mentioning `scribe`, which woke scribe, whose answer then tried `lead` as the thread's owner; and `lead` mentioning `codex`, which got the one-line notice that tools need `wakeOnAgentPosts`.
