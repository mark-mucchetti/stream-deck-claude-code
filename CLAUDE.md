# CLAUDE.md

Project memory for future Claude Code sessions in this repo.

## What this is

A **Stream Deck plugin** that shows live status for every running Claude Code session — one tile per session, color-coded state, project name, press-to-focus the iTerm / VS Code / Terminal window. Distributable via Elgato Marketplace.

Plugin UUID: `com.virtuis.claudecode`. Action UUID: `com.virtuis.claudecode.session`.

## Architecture

```
Claude Code  ──►  ~/.claude/hooks/stream-deck-bridge.sh    (captures $(tty))
                            │
                            ▼
                ~/.claude/hooks/stream-deck-bridge.py    (merges env, POST)
                            │
                            ▼
                127.0.0.1:13427/event   ◄── plugin HTTP server (Node, in-process)
                            │
                            ▼
                SessionStore (EventEmitter)
                            │
                            ▼
                SessionAction.renderAll() → paints all tiles
```

- **Hooks are command-type**, not http-type, so the bridge script can capture process-local env (`TERM_PROGRAM`, `ITERM_SESSION_ID`, `$(tty)`, `VSCODE_PID`) and forward it inside the payload.
- **State** lives only in memory + Stream Deck `globalSettings` (debounced 500ms). No SQLite, no Redis, no Claude Code daemon to query.
- **Hydration** on plugin start pulls sessions from `globalSettings`. **No age filter** — a session waiting on a human for hours is exactly what the tile is supposed to keep surfacing.
- **No runtime timeouts.** State changes ONLY on real hook events. The user rejected auto-idle ("it's in the state it's in until it changes"); don't reintroduce.

## File map

- `src/plugin.ts` — entry. Register action → connect → hydrate from `globalSettings` → start HTTP server → bind action → wire persistence.
- `src/server.ts` — HTTP server. Maps hook events to state transitions. Logs every event.
- `src/state.ts` — `SessionStore` (EventEmitter). `upsert / apply / remove / serialize / hydrate`.
- `src/render.ts` — SVG → data-URI. Renders the project label *inside* the SVG (Stream Deck's own title rendering is too small to be useful).
- `src/focus.ts` — macOS-only AppleScript dispatch. iTerm by `unique id` from `ITERM_SESSION_ID`, Terminal.app by `tty`, VS Code/Cursor by window title containing `basename(cwd)`.
- `src/install.ts` — installs / removes `~/.claude/hooks/stream-deck-bridge.{sh,py}` and merges/unmerges hook entries into `~/.claude/settings.json`. Marker key: `_source: "stream-deck-claude-code"`. Preserves unrelated entries.
- `src/actions/session-action.ts` — the single SingletonAction. Handles `onWillAppear`, `onKeyDown`, `onSendToPlugin` (PI messages). Sorts physical tiles by `(device, row, column)` and pairs them with `store.list()[i]` — sessions pack into the leftmost/topmost free tiles in arrival order.
- `com.virtuis.claudecode.sdPlugin/manifest.json` — plugin manifest.
- `com.virtuis.claudecode.sdPlugin/ui/session.html` — Property Inspector. Uses `sdpi-components` from CDN. Talks to plugin via `sendToPlugin({event: "installHooks" | "uninstallHooks" | "getHookStatus"})`.
- `scripts/{smoke,install-smoke,bridge-e2e,salient-smoke}.mts` — `npm test` runs all four.
- `src/strings.ts` — every user-facing string rendered into a tile, in one object.
- `src/transcript.ts` — read the tail of a session's transcript JSONL for `aiTitle`, last prompt, and `User rejected tool use` markers.
- `scripts/install-hooks.mjs` — standalone CLI alternative to the PI install button.

## State machine

| Event                                                                   | State          |
|-------------------------------------------------------------------------|----------------|
| `SessionStart`                                                          | `idle`         |
| `UserPromptSubmit`                                                      | `thinking` (amber) |
| `PreToolUse` (normal tool)                                              | `working` (blue, + tool name) |
| `PreToolUse` (`AskUserQuestion`, `ExitPlanMode`)                        | **`waiting`**  |
| `PostToolUse` / `PostToolUseFailure`                                    | `working`      |
| `PostToolBatch`                                                         | `thinking`     |
| `PermissionDenied`                                                      | `working`      |
| `PermissionRequest`                                                     | **`waiting`**  |
| `Elicitation`                                                           | **`waiting`**  |
| `ElicitationResult`                                                     | `working`      |
| `Notification.permission_prompt` / `Notification.elicitation_dialog`    | **`waiting`**  |
| `Notification.idle_prompt`                                              | `done`         |
| `Notification.elicitation_complete` / `Notification.elicitation_response` | `working`    |
| `Stop`                                                                  | `done`         |
| `StopFailure`                                                           | `error`        |
| `SessionEnd`                                                            | *remove from list* |

**Every event category that blocks Claude on a human response must surface as `waiting` (red, fast pulse).** That includes the four `PreToolUse` blocking-tool cases, `PermissionRequest`, `Elicitation`, and the two `Notification` subtypes. If a future Claude Code version adds more, register them in `install.ts:EVENTS` and add them to `stateFor()` in `server.ts`.

`SessionEnd` removes the session immediately (no "ended" intermediate state). If the user runs `claude --resume`, `SessionStart` re-adds it with the same `session_id`.

## Tile assignment

Active sessions pack into tiles in **arrival order**, from top-left → bottom-right in grid order (sorted by `(device, row, column)`). When a session ends, sessions after it shift up one slot; empty tiles always trail at the end. No sticky assignment — `store.list()[i] → slots[i]`, trivially.

The user explicitly rejected sticky slot ownership ("when session ends, that's when it is no longer taking the tile"). Don't reintroduce.

## Building & running

```sh
npm install
npm run build       # rollup → com.virtuis.claudecode.sdPlugin/bin/plugin.js
npm run watch       # build on change
npm test            # smoke + install + bridge-e2e + salient
```

First-time setup for local dev — symlink the plugin folder into Stream Deck's plugin directory so the Stream Deck app finds it:

```sh
ln -s "$(pwd)/com.virtuis.claudecode.sdPlugin" \
  "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.virtuis.claudecode.sdPlugin"
```

Then quit + reopen the Stream Deck app. (Optional: install `@elgato/cli` and use `streamdeck restart com.virtuis.claudecode` instead.)

### Hot-reload the plugin during dev (no Stream Deck app restart)

```sh
pkill -f "com.virtuis.claudecode.sdPlugin/bin/plugin.js"
# Stream Deck app respawns it within ~2s
```

Reload + read logs directly when debugging — don't ask the human to paste output:

```sh
ls -t com.virtuis.claudecode.sdPlugin/logs/*.log | head -1 | xargs tail -40
curl -s http://127.0.0.1:13427/sessions | python3 -m json.tool
```

### Standalone CLI install/uninstall of hooks

If Stream Deck isn't running (or for headless boxes), the install logic is also exposed as a CLI:

```sh
npm run install-hooks      # same effect as PI's Install button
npm run uninstall-hooks    # remove every hook entry we own
```

### Packaging for Marketplace distribution

```sh
npm install -g @elgato/cli
npm run package      # → com.virtuis.claudecode.streamDeckPlugin
```

Submission flow: register a Maker ID with Elgato, then follow [the submission guide](https://docs.elgato.com/streamdeck/marketplace/submissions/).

## Things the user has said clearly

- **macOS only for now.** Don't build Windows polish.
- **No silent `~/.claude/settings.json` changes.** Setup is explicit via the PI's Install button. Top-up of new events on plugin start is OK *only* if the user previously opted in (see `isPartiallyInstalled`).
- **Don't ask the user to paste log output.** Read the logs yourself, reload the plugin yourself.
- **Simple > clever.** I tried sticky slot ownership; user pushed back hard. Listen to the simpler intuition.
- **Don't paste user/business data into tracked files.** Test fixtures use placeholder project names (`alpha`, `beta`, `api-client`). Real session titles, project basenames, and internal product names belong only in ad-hoc debugging, never in committed source.

## UX rules — minimum sizes & weights

Stream Deck tiles render at 144×144 viewBox. These minimums are non-negotiable; the user has called every one of them out at least once.

| Element | Font size (min) | Weight | Color | Notes |
|---|---|---|---|---|
| Project name, single line (≤9 chars) | **26pt** | 700 bold | `#ffffff` | bigger sizes for shorter names — see `pickSingleLineSize` |
| Project name, single line (≤13 chars) | **18pt** | 700 bold | `#ffffff` | textLength squeeze if estimated width > 132px |
| Project name, two-line wrap (each line) | **14pt** | 700 bold | `#ffffff` | wraps on a `-/_/.` separator near the middle; keep separator visible |
| Salient subtitle (middle) | **24pt** | 300 light | `#cdd2dc` | truncate at 10 chars with `…`, NOT smaller font |
| Status caption (bottom band) | **26pt** | 700 bold | per-theme | marquee scroll when text overflows 132px, NOT shrink |

**Iron rules:**

1. **"Lighter" means font weight, never font size.** When the user says lighter, change `font-weight`. Never shrink size as a response to that feedback.
2. **Bigger > clever.** When in doubt, go up a tier. Repeated feedback has been "still too small".
3. **No silent truncation in the data layer.** The renderer owns fit. `deriveLabel` returns the full basename; never pre-cut with `…`.
4. **Overflow handling**: for dynamic content (tool names, captions during `working`), scroll horizontally — see `paintBand` marquee logic. For project labels, squeeze with `textLength="132" lengthAdjust="spacingAndGlyphs"` or wrap to two lines. Don't add a "..." for content the renderer should size itself.
5. **Animation is polling-only.** `setImage` does not play animated GIFs at runtime. Don't waste time on `@resvg/resvg-js` + `gifenc` — it's been tried, it doesn't work. The `animationTick` in `session-action.ts` runs every `ANIM_TICK_MS` (defined in `render.ts`; currently 50ms / 20fps) with a brightness skip-epsilon to keep RPC traffic low. Marquee-scrolling captions bypass the dedup so they don't freeze during brightness plateaus.
6. **The empty-tile dot was removed for consistency** with active tiles. Don't add it back without checking — the user explicitly flagged the inconsistency.
7. **Project name is top-anchored**, not centered in the upper region. `NAME_TOP=6`, baseline = `NAME_TOP + fontSize * 0.82`. Don't center; user has called this out.

## Known gotchas

- **Existing claude sessions don't appear** until they fire their next hook (any keystroke / enter). Documented in the PI's Tips section.
- **VS Code window focus** can only resolve to the workspace window — not a specific integrated terminal pane. AppleScript can't reach that far. Fixing it properly would need a companion VS Code extension exposing a URI handler.
- **`tty(1)` returns "not a tty"** when run with piped stdio (e.g. our e2e test). The Python bridge filters anything not starting with `/dev/`. In real Claude Code hook invocations the controlling tty is present.
- **Decorators**: this project uses TC39 (Stage 3) decorators via the Elgato SDK, not legacy `experimentalDecorators`. `tsconfig.json` must keep `experimentalDecorators: false`.
- **Animated GIFs DO NOT WORK via `setImage`.** Confirmed via web search: the SDK accepts animated GIFs in the manifest for static button definitions, but `setImage`/`setFeedback` only render the first frame. (Iron rule #5 above has the full story; this entry is the historical "we already burned days on this" note.)
- **`cwd` from hook payloads drifts** — Claude Code reports the *current* cwd at the time of the event, which changes when the agent runs `cd`. `SessionStore.upsert` is sticky on cwd after the first event for a session so the tile label doesn't flip mid-session. Don't change that behavior.
- **Don't `cd` in Bash tool calls.** Bash sessions share cwd, so `cd foo && bar` poisons every subsequent hook payload's `cwd`. Always use absolute paths. The sticky-cwd fix above only kicks in for existing sessions; new sessions started in the wrong dir get the wrong label.
- **All "waiting" events must be registered AND mapped.** Both halves matter: if you only register the event in `install.ts:EVENTS` without mapping it in `server.ts:stateFor`, nothing happens. If you only map it without registering, Claude Code never fires the hook to begin with. The complete list of hook events that mean "blocked on user" is in the state machine table above — don't trim it.

## What's next (UX work)

Things worth revisiting:

- Tile rendering at different deck sizes / device DPRs (only tested on Stream Deck Mini so far).
- Marquee scroll speed (`CAPTION_SCROLL_PX_PER_TICK` — currently 2 at 20fps = 40px/sec; tune if needed).
- Whether the salient-word picker (`salientWord` in `render.ts`) handles non-English titles gracefully.
