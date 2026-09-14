const { cpSync, mkdirSync, rmSync } = require("fs");
const { join } = require("path");
const { execFileSync } = require("child_process");

const root = join(__dirname, "..");
const target = join(root, "frontend", "vendor");
const files = [
  ["markdown-it/dist/markdown-it.min.js", "markdown-it.min.js"],
  ["markdown-it-task-lists/dist/markdown-it-task-lists.min.js", "markdown-it-task-lists.min.js"],
  ["katex/dist/katex.min.css", "katex.min.css"],
  ["@highlightjs/cdn-assets/styles/github-dark.min.css", "highlight-github-dark.min.css"],
  ["@highlightjs/cdn-assets/highlight.min.js", "highlight.min.js"]
];

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const [source, destination] of files) cpSync(join(root, "node_modules", source), join(target, destination));
cpSync(join(root, "node_modules", "katex", "dist", "fonts"), join(target, "fonts"), { recursive: true });
execFileSync(join(root, "node_modules", ".bin", "browserify"), [join(root, "node_modules", "markdown-it-katex", "index.js"), "--standalone", "markdownitKatex", "-o", join(target, "markdown-it-katex.min.js")], { stdio: "inherit" });
