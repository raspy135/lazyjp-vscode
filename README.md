# lazyjp (VS Code)

Rewrite the current line of romaji-ish text into natural Japanese with an LLM, in
the background. A VS Code port of the `lazyjp` command from the pem editor.

Type something like `kyou wa ii tenki desu`, press the shortcut, and the line is
replaced in place with `今日はいい天気です`. The request runs in the background, so
you can keep editing; the result lands on the **original** line even if the cursor
(or line numbers) moved while you waited.

## Setup

1. Install [Node.js](https://nodejs.org) (LTS) if you don't have it.
2. In a terminal, run:
   ```
   npm install
   npm run install-ext
   ```
3. Reload VS Code when prompted.
4. Run **`lazyjp: Set API Key`** from the Command Palette and paste your OpenAI key
   (stored in VS Code SecretStorage, not in settings).


## Usage

| Command | Default key | What it does |
|---|---|---|
| `lazyjp: Convert Line to Japanese` | `Ctrl+Alt+J` (`Cmd+Alt+J` on macOS) | Convert the current line. |
| `lazyjp: Toggle Continuous Mode` | — | Chain turns for consistent kanji/vocabulary (more tokens) vs. independent calls (cheaper). |
| `lazyjp: Reset Session` | — | Start a fresh conversation in continuous mode. |
| `lazyjp: Set API Key` | — | Store / replace your OpenAI API key. |

Rebind the shortcut via **Preferences: Open Keyboard Shortcuts** and searching for
`lazyjp.convertLine`.

## Settings

- `lazyjp.model` — model id (default `gpt-5.4-mini`). Must be valid for your key.
- `lazyjp.baseUrl` — API base URL (default `https://api.openai.com/v1`). Point at a
  proxy if your model id is served elsewhere.
- `lazyjp.prompt` — the instruction text prepended to the line.
- `lazyjp.continuous` — start in continuous mode (default on).
- `lazyjp.reasoningEffort` — `low`/`medium`/`high`, sent only for reasoning models;
  leave empty to omit.

## Continuous mode

Off (default): every line is an independent, cheap one-shot. 

On: each conversion chains to the previous one via the Responses API's `previous_response_id`, so the
model keeps consistent vocabulary/kanji across lines — at the cost of many more
tokens as context grows. A fresh chat starts when you switch files, toggle the mode
on, or run *Reset Session*.
