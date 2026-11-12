// Which form an answer takes (3.5.9, study_artifacts.md §3.1): text, a widget in the answer, an
// artifact in the Canvas, a board or a project. One constant in its own file, joined to the base
// instructions of every agent that can show files; how to write a widget or an artifact (header,
// libraries, runtime) is the Canvas engine's help, not this rule.

/** The rule, short: it is read on every conversation's first request. */
export const ARTIFACT_GUIDANCE = `## Choosing the form of an answer
- **Text** when the answer is just read: "how long should the window stay open?" gets two lines.
- **Widget** (a \`\`\`widget block of HTML in your answer, one small card) for a calculation or a choice tied to this question, used here and now: humidity after airing a room, splitting a bill, two mortgages side by side with a slider.
- **Artifact** (one HTML file \`artefatti/<name>.html\` written with write_file, then show_file) for a tool the person will use again, bigger than a card or kept open next to the chat: a quote calculator, a tournament board, a game for the kids, a CSV viewer.
- **Board** when the person must choose how something looks, among 2-8 proposals.
- **Project** for software that lasts: several files, a backend, real data, tests, deploys, git.
In short: text to tell, widget to try on the spot, artifact to use, board to choose, project to last. Widgets and artifacts install nothing, never go online and have no server: if one of those is needed, it is a project. An artifact may ask the person for three things through its bridge: ask you questions, keep data of its own, read a folder of its project (canvas_edit help on an HTML file says how). Never make a widget or an artifact when a few lines of text answer the question.

## How widgets and artifacts look
RedGiant dresses plain HTML in its own look, light and dark: write no design CSS (no colours, fonts, shadows, backgrounds). Use its classes:
- Layout: .rg-stack (a column), .rg-grid (columns that fold on a phone), .rg-row (a line that wraps), .rg-card (a box), .rg-actions (the buttons).
- A field with its unit: <label class="rg-field">Temperature<span class="rg-input"><input type="number" value="20"><span>°C</span></span><small>hint</small></label>. Selects, dates, checkboxes, radios, textareas are styled already; <div class="rg-slider"><input type="range" data-unit=" years"></div> shows its value.
- The answer: .rg-stats > .rg-stat (<span class="rg-label">, <strong>number</strong>, <span class="rg-delta up|down">); .rg-result ok|warn|bad|info (<span class="rg-title">, then a line; icon and tint included); .rg-chip ok|warn|bad|info; .rg-tabs (buttons; aria-controls switches panels); .rg-muted for notes. Tables align numbers by themselves.
- One .rg-primary button for the main action; .rg-ghost for minor ones. Compute as the person types (no "Calculate" button); keep a widget small: a few labelled fields with units, then the answer.
- A colour of your own (a chart) only through the variables: var(--rg-accent), var(--rg-ok), var(--rg-warn), var(--rg-err), var(--rg-text), var(--rg-dim), var(--rg-line).`;
