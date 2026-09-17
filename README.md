# Noname ReplayLab (Replay Tool Extension)

#### [中文文档](https://github.com/Faide-cyber/ReplayLab/blob/main/README_zh.md)

### 1. Project Overview

**ReplayLab (Replay Tool)** is an extension running inside **Noname** (the single-player Three Kingdoms Kill engine). It is an experimental bench built specifically for generals like **Sun Chen (势孙綝)** who are **extremely sensitive to hand-card ordering and play sequence**.

It packages the entire current game state — hand cards, equipment, judgment zone, HP, max HP, chained status, flipped status, marks, skill states, once-per-turn counters, and deck order — into one snapshot. Once you finish a trial run, you can **restore it exactly**, try another ordering, and then compare the two attempts side by side.

The one core question it answers: **With the same hand, how much does a different play order change the result?**

Traditionally, you would have to restart the whole match and re-deal the cards after every attempt — extremely expensive and impossible to reproduce. ReplayLab turns "record start → play once → save record → restore start → replay with a new order → compare" into a matter of seconds, and **the deck is restored completely, both in order and in count**, so even "which card you draw" can be quantitatively compared.

### 2. System Architecture and Features

#### 2.1 Core Features

- **Snapshot / One-click Rollback**: The entire state is stored and restored — the deck, discard pile, and processing area keep their exact ordering; dead players are revived; "resting" / out-of-game states return to their original form.
- **Parallel Comparison of Multiple Attempts** (the "multi-model" of this tool is "multi-attempt"): All records are selected by default and go straight into the comparison table; multiple records never misalign.
- **Custom Hand Cards**: Add cards by name (Chinese / English ID / with suit and number), with two modes: **Virtual Card** and **Draw from Deck (targeted search)**; tap to discard, clear all, draw 1, or push the current hand back to the start-of-record hand.
- **Statistics Range**: Damage (hand-card damage / skill damage / by target / by source / by element / Nigu bonus), card flow (gain / lose / discard), HP changes (start-of-record vs. current for each player), and play-order strings.
- **Faction Coloring**: Enemy red, ally green, unknown yellow, self white; the statistics cover four columns — "vs. enemy / vs. ally / unknown / self-taken" — plus a total-reconciliation row.
- **Reveal Opponent Hands**: By default, when the engine asks you to pick a card from an opponent's hand, the cards are shown face-down and shuffled by `randomSort()`. Enabling this option lists them by real face, so you can actually pick the same card after a rollback.
- **Deck Category HUD**: One line shows the composition of the deck (self-basic / enemy-basic / self-trick / enemy-trick / other-trick / equipment / dead-cards).

#### 2.2 Engineering Constraints

- The extension's `content` / `filter` are **rebuilt** by the engine with `new Function`, so all closure variables are lost → hooks must be a single line forwarding to `window.hfTool`, wrapped in `try/catch` so the tool never breaks the game.
- Phase hooks must use **real** event names that exist in the engine (`phaseUseBegin` / `phaseUseEnd` / `phaseDiscardBegin` …). Writing a name like `phaseUse` that doesn't exist will **silently never fire**.
- Card IDs are English (`sha` / `tao` / `tiesuo`); Chinese card names must first be looked up via `lib.translate`.
- The engine's `game.updatez()` adds `transform: scale()` to `<body>`, so all floating UI is mounted on `document.documentElement`.

### 3. Environment Requirements and Dependencies

**Runtime Environment**

- "Liuli-version Noname" bundle (Electron app with Noname engine 1.9.0) or any Noname engine capable of loading extensions.
- Desktop / mobile with WebView support; the extension directory must be writable.
- Optional: `localStorage` (remembers toggles and floating UI positions).

**Development Environment**

- Node.js and a UTF-8 capable editor.

### 4. Installation and Deployment

#### 4.1 Installing the Extension

1. Place the entire `复盘工具/` directory into your Noname extension directory `extension`. The path varies by Noname version — check your own installation.
2. Launch the game → **Extension Manager** → enable "复盘工具" (Replay Tool).
3. **Start a match**. A blue water-wave orb appearing means it has loaded successfully.

Noname only reads code at match start / extension load time, so **you must restart the game** (or reload the extension) after any change for it to take effect.

#### 4.2 Configuration

- Six toggles on the Start tab (all off by default): **Deck Category / Reveal Hands / Auto Snapshot / Bubble Pin / End Prompt / Default Naming**.
- Hand-card add mode: **Virtual Card (does not touch the deck) / Draw from Deck (targeted search)**.
- Toggles and floating UI positions are written into `localStorage`: `hf_cfg` / `hf_btn_pos` / `hf_panel_pos` / `hf_pilebar_pos`.

### 5. Usage Flow

1. **Record Start**: In your own Play Phase, tap **Record**; or turn on **Auto Snapshot** on the Start tab — a snapshot is stored every Play Phase (a manual start always takes priority).
2. **Play Normally**: The tool automatically records damage, card flow, HP changes, and the play-order string.
3. **Save Record and Roll Back**: Tap **Redo** = save one record and restore the start; tap **Stop** = save one record and jump to the "Records" tab.
4. **Compare and Export**: The comparison table on the Records tab **selects all records by default**, and records can be exported.

### 6. License

You may redistribute and/or modify this program under the terms of the GNU General Public License as published by the Free Software Foundation — either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with this program. If not, see http://www.gnu.org/licenses/ .

### 7. Disclaimer

**ReplayLab (Replay Tool)** (hereinafter "this project") is intended for learning and research purposes only. Any illegal use is strictly prohibited. If you choose to use any part of this project, you must comply with all relevant laws and regulations and bear all responsibility arising from it.

The author is not responsible for any loss or damage caused by the use of this project. If you choose to use any part of this project, you do so at your own risk and responsibility.

The author reserves the right to pursue legal liability against anyone who illegally uses this project. If you choose to use any part of this project for illegal activities, you will face legal proceedings and other penalties.

Users should comply with relevant laws and regulations and respect the author's intellectual property rights. Any legal dispute arising from a violation of the above shall be borne entirely by the user.

The interpretation right of this statement belongs to the author.

### 8. Additional Information

- **Latest Source Code and Docs**
  Please visit the GitHub repository for the latest source code and documentation updates: https://github.com/Faide-cyber/
- **Noname Engine / Extension Development**
  See the official Noname repository and extension development docs: https://github.com/libnoname/noname

### 9. Contact

WeChat / Email: 1350038426@qq.com

If you have any questions or feedback, you can also reach out via a GitHub issue.

When submitting an issue, please describe your problem clearly and provide sufficient context (for example, the diagnostic line printed by `hfTool.diag()` in the console), so that I can better understand and answer your question.

![QQ Contact Image](https://github.com/Faide-cyber/MouseCopy/assets/148406475/8b7ac122-d438-4d64-b6d0-330b514e4389)
