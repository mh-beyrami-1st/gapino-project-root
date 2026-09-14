const { cpSync, mkdirSync, rmSync, writeFileSync, unlinkSync } = require("fs");
const { join } = require("path");
const { execFileSync } = require("child_process");

const root = join(__dirname, "..");
const target = join(root, "frontend", "vendor");

const files = [
  ["markdown-it/dist/markdown-it.min.js", "markdown-it.min.js"],
  ["markdown-it-task-lists/dist/markdown-it-task-lists.min.js", "markdown-it-task-lists.min.js"],
  ["katex/dist/katex.min.css", "katex.min.css"],
  ["katex/dist/katex.min.js", "katex.min.js"],
  ["@highlightjs/cdn-assets/styles/github-dark.min.css", "highlight-github-dark.min.css"],
  ["@highlightjs/cdn-assets/highlight.min.js", "highlight.min.js"],
];

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

for (const [source, destination] of files) {
  cpSync(join(root, "node_modules", source), join(target, destination));
}

cpSync(
  join(root, "node_modules", "katex", "dist", "fonts"),
  join(target, "fonts"),
  { recursive: true },
);

const entryFile = join(root, "scripts", "texmath-entry.js");

writeFileSync(
  entryFile,
  `window.markdownitTexmath = require("markdown-it-texmath");\n`,
  "utf8",
);

execFileSync(
  join(root, "node_modules", ".bin", "browserify"),
  [
    entryFile,
    "--standalone",
    "markdownitTexmathBundle",
    "-o",
    join(target, "markdown-it-texmath.min.js"),
  ],
  { stdio: "inherit" },
);

unlinkSync(entryFile);