# Stream Deck × Claude Code

A Stream Deck plugin that turns your deck into an **ambient conductor** for every Claude Code session you're running.

- One tile per active Claude Code terminal session.
- Color + animation shows state: **idle**, **thinking**, **working**, **waiting for you**, **done**, **error**.
- Tile shows the project name plus a one-word summary of what Claude is doing.
- Press a tile to jump to the iTerm / Terminal / VS Code window running that agent.

Built for the moment you've kicked off five Claude sessions across five repos and want to glance over and see which one is waiting on you.

## Using it

Once the plugin is loaded into your Stream Deck app:

1. Drag a **Session** tile from the *Claude Code* category onto your deck. The empty tile shows **"setup needed"** until you install the hooks.
2. **Click the tile on the canvas** in the Stream Deck app — the right-side Property Inspector appears. Click **Install Claude Code hooks**. This adds entries to `~/.claude/settings.json` (preserving anything already there) and the status dot turns green.
3. Drop more Session tiles as you want — they fill in physical-layout order (top-left → bottom-right) as Claude sessions emit events.
4. Start a `claude` session in any terminal. Watch a tile light up.

To remove the hooks cleanly, click **Uninstall Claude Code hooks** in the same Property Inspector.

## Tile states

| State      | Color       | Meaning                                                |
|------------|-------------|--------------------------------------------------------|
| idle       | gray        | Session is alive but quiet.                            |
| thinking   | amber pulse | Claude is composing a response to your prompt.         |
| working    | blue pulse  | Claude is running a tool — the tool name is shown.     |
| waiting    | red pulse   | Claude needs you: permission prompt, AskUserQuestion, ExitPlanMode, or an MCP elicitation. |
| done       | green       | Claude finished the turn; your move. After 10 min idle, the tile also shows how long it's been waiting (e.g. `ready (12m)`). |
| error      | red         | The turn ended in an API or tool error.                |

`SessionEnd` (you `^C`-quit or `/quit` the session) removes the tile right away. `claude --resume` brings it back.

## Pressing a tile

Each tile knows the terminal that started its session:

- **iTerm2** — captured `ITERM_SESSION_ID` matches iTerm's AppleScript `unique id`, so we jump to *the exact session* (not just the iTerm app).
- **Terminal.app** — match by controlling tty.
- **VS Code / Cursor** — activate the app and raise the window whose title contains the project folder name. (AppleScript can't pick a specific integrated-terminal pane, so this is best-effort.)
- **Fallback** — open the project folder in Finder.

## Known caveats

- **macOS only** for the focus-on-press behavior. The status board itself would work on Windows; pressing a tile there is a no-op for now.
- **VS Code window granularity.** AppleScript surfaces the workspace window but can't pick a specific terminal pane within it.
- **Tile order is placement order.** Sessions fill the tiles you've placed, top-left first, in arrival order. When a session ends, the rest shift up.
- **Already-running Claude sessions** don't appear until they fire their next hook event — type any character (even just `↵`) in the terminal to wake them up.

## License

MIT
