const { cpSync, existsSync, mkdirSync, rmSync } = require("fs");
const { join } = require("path");

const root = join(__dirname, "..");
const modules = join(root, "node_modules");
const target = join(root, "frontend", "vendor");

// Maps a package path inside node_modules to its published file in frontend/vendor.
const files = [
  ["markdown-it/dist/markdown-it.min.js", "markdown-it.min.js"],
  ["markdown-it-task-lists/dist/markdown-it-task-lists.min.js", "markdown-it-task-lists.min.js"],
  ["@highlightjs/cdn-assets/styles/github-dark.min.css", "highlight-github-dark.min.css"],
  ["@highlightjs/cdn-assets/highlight.min.js", "highlight.min.js"],
  ["mathjax/es5/tex-mml-chtml.js", "tex-mml-chtml.js"],
];

if (!existsSync(modules)) {
  console.error("node_modules is missing. Run `npm install` before building the vendor bundle.");
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

for (const [source, destination] of files) {
  cpSync(join(modules, source), join(target, destination));
}
