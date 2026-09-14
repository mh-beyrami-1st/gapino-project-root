const { cpSync, mkdirSync, rmSync } = require("fs");
const { join } = require("path");

const root = join(__dirname, "..");
const target = join(root, "frontend", "vendor");

const files = [
  ["markdown-it/dist/markdown-it.min.js", "markdown-it.min.js"],
  ["markdown-it-task-lists/dist/markdown-it-task-lists.min.js", "markdown-it-task-lists.min.js"],
  ["@highlightjs/cdn-assets/styles/github-dark.min.css", "highlight-github-dark.min.css"],
  ["@highlightjs/cdn-assets/highlight.min.js", "highlight.min.js"],
];

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

for (const [source, destination] of files) {
  cpSync(join(root, "node_modules", source), join(target, destination));
}