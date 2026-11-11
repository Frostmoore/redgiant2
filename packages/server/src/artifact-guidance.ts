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
In short: text to tell, widget to try on the spot, artifact to use, board to choose, project to last. Widgets and artifacts install nothing, never go online and have no server: if one of those is needed, it is a project. Never make a widget or an artifact when a few lines of text answer the question.`;
