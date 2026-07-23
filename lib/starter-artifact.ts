function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function makeStarterArtifact(roomName: string) {
  const safeName = escapeHtml(roomName);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${safeName}</title>
  <style>
    :root{--ink:#11120f;--paper:#f7f5ec;--lime:#caff45;--line:#cdcec4;color-scheme:light}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;background:var(--paper);color:var(--ink);font-family:Arial,sans-serif}
    header{display:flex;align-items:center;gap:10px;height:54px;padding:0 18px;border-bottom:1px solid var(--line);font-size:12px;font-weight:700}
    .mark{display:grid;width:28px;height:28px;place-items:center;border-radius:50%;background:var(--ink);color:var(--lime);font:700 9px monospace}
    main{max-width:620px;margin:auto;padding:42px 24px}
    .eyebrow{font:700 9px monospace;letter-spacing:.12em;color:#686b61}
    h1{max-width:520px;margin:14px 0 12px;font-size:clamp(38px,8vw,68px);line-height:.92;letter-spacing:-.07em}
    .sub{max-width:440px;color:#66695f;font-size:14px;line-height:1.5}
    .choices{display:grid;gap:8px;margin:30px 0 16px}
    .choices input{position:absolute;opacity:0;pointer-events:none}
    .choices label{width:100%;padding:16px;border:1px solid var(--line);border-radius:9px;background:#ecebe3;color:var(--ink);font:600 13px Arial;text-align:left;cursor:pointer}
    .choices label:hover,.choices input:focus-visible+label,.choices input:checked+label{border-color:var(--ink);background:var(--lime)}
    #result{min-height:48px;padding:15px;border-radius:9px;background:var(--ink);color:var(--paper);font:600 11px monospace;line-height:1.5}
    .answer{display:none}.default{display:block}
    #low:checked~#result .default,#move:checked~#result .default,#surprise:checked~#result .default{display:none}
    #low:checked~#result .low,#move:checked~#result .move,#surprise:checked~#result .surprise{display:block}
  </style>
</head>
<body>
  <header><span class="mark">t/p</span><span>${safeName}</span></header>
  <main>
    <p class="eyebrow">TONIGHT · A SMALL DECISION</p>
    <h1>What kind of night do you need?</h1>
    <p class="sub">Choose the feeling first. This starter app works now; your room can rebuild every part of it together.</p>
    <div class="choices" role="group" aria-label="Choose a kind of night">
      <input id="low" name="night" type="radio" /><label for="low">Low-key</label>
      <input id="move" name="night" type="radio" /><label for="move">Move around</label>
      <input id="surprise" name="night" type="radio" /><label for="surprise">Surprise me</label>
      <div id="result" aria-live="polite">
        <span class="default">Pick one. The app will make the next decision smaller.</span>
        <span class="answer low">Keep it close: one familiar person, somewhere quiet.</span>
        <span class="answer move">Move a little: a walk, a game, or one loose destination.</span>
        <span class="answer surprise">Hand the choice to the group and opt in when it feels right.</span>
      </div>
    </div>
  </main>
</body>
</html>`;
}

const scriptNonce = "make-room-project";
const securityMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src data:; font-src data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'" /><meta name="referrer" content="no-referrer" />`;

export function secureArtifactHtml(input: string) {
  if (byteLength(input) > 150_000) {
    throw new Error("The artifact exceeded the stored preview limit.");
  }
  const html = input.trim();
  const withoutBase = html.replace(/<base\b[^>]*>/gi, "");
  const withoutScripts = withoutBase.replace(
    /<script\b[^>]*>[\s\S]*?<\/script>/gi,
    "",
  );
  const withoutExternalStyles = withoutScripts.replace(
    /<link\b[^>]*\brel\s*=\s*(["'])stylesheet\1[^>]*>/gi,
    "",
  );

  if (/<head\b[^>]*>/i.test(withoutExternalStyles)) {
    return withoutExternalStyles.replace(/<head\b[^>]*>/i, (head) => `${head}${securityMeta}`);
  }

  return `<!doctype html><html><head><meta charset="utf-8" />${securityMeta}</head><body>${withoutExternalStyles}</body></html>`;
}

export type GeneratedSource = {
  html: string;
  css: string;
};

export const artifactSourcePaths = [
  "index.html",
  "styles.css",
  "src/app.js",
  "README.md",
] as const;

export type ArtifactSourcePath = string;
export type ArtifactLanguage =
  | "html"
  | "css"
  | "javascript"
  | "json"
  | "markdown"
  | "text";

export type ArtifactSourceFile = {
  path: ArtifactSourcePath;
  content: string;
  language: ArtifactLanguage;
};

export type ProjectTemplate = "game" | "app";

export const MAX_PROJECT_FILES = 40;
export const MAX_PROJECT_FILE_BYTES = 65_536;
export const MAX_PROJECT_BYTES = 524_288;

export function inferArtifactLanguage(path: string): ArtifactLanguage {
  const lower = path.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "markdown";
  return "text";
}

export function validateArtifactPath(rawPath: string) {
  const path = rawPath.trim();
  if (
    !path ||
    path.length > 120 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("//") ||
    !/^[A-Za-z0-9._/-]+$/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(
      "File paths may use letters, numbers, dots, dashes, underscores, and folders.",
    );
  }
  return path;
}

export function validateArtifactFiles(
  input: ReadonlyArray<
    Pick<ArtifactSourceFile, "path" | "content"> &
      Partial<Pick<ArtifactSourceFile, "language">>
  >,
) {
  if (input.length < 2 || input.length > MAX_PROJECT_FILES) {
    throw new Error(`A project must contain 2–${MAX_PROJECT_FILES} files.`);
  }
  const files: ArtifactSourceFile[] = [];
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const inputFile of input) {
    const path = validateArtifactPath(inputFile.path);
    if (paths.has(path)) throw new Error(`Duplicate source path: ${path}`);
    paths.add(path);
    if (typeof inputFile.content !== "string") {
      throw new Error(`${path} must contain plain text.`);
    }
    const fileBytes = byteLength(inputFile.content);
    if (fileBytes > MAX_PROJECT_FILE_BYTES) {
      throw new Error(`${path} exceeded the 64 KB project-file limit.`);
    }
    totalBytes += fileBytes;
    if (totalBytes > MAX_PROJECT_BYTES) {
      throw new Error("The project exceeded the 512 KB source limit.");
    }
    const language = inferArtifactLanguage(path);
    if (inputFile.language && inputFile.language !== language) {
      throw new Error(`${path} has invalid language metadata.`);
    }
    files.push({ path, content: inputFile.content, language });
  }
  if (!paths.has("index.html") || !paths.has("styles.css")) {
    throw new Error("A project must contain index.html and styles.css.");
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function extractArtifactSource(input: string): GeneratedSource {
  const bodySource = input.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1];
  if (bodySource === undefined) {
    throw new Error("The stored artifact could not be opened as source files.");
  }
  const body = bodySource.replace(
    /<script\b[^>]*\bdata-make-room-entry\b[^>]*>[\s\S]*?<\/script>/gi,
    "",
  );

  const styles: string[] = [];
  for (const match of input.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    styles.push(match[1] ?? "");
  }

  return { html: body.trim(), css: styles.join("\n").trim() };
}

export function sourceFilesFromGenerated(
  source: GeneratedSource,
): ArtifactSourceFile[] {
  return [
    { path: "index.html", content: source.html.trim(), language: "html" },
    { path: "styles.css", content: source.css.trim(), language: "css" },
  ];
}

function makeGameStarterProject(roomName: string): ArtifactSourceFile[] {
  return validateArtifactFiles([
    {
      path: "index.html",
      language: "html",
      content: `<main class="game-shell">
  <header class="game-header">
    <div>
      <span class="eyebrow">PLAYABLE BUILD · CANVAS 2D</span>
      <h1>${escapeHtml(roomName)}</h1>
    </div>
    <div class="scoreboard"><span>SPARKS</span><strong id="score">0 / 7</strong></div>
  </header>
  <section class="stage" aria-label="Playable game">
    <canvas id="game" width="960" height="540" aria-label="Move the lime player and collect seven sparks"></canvas>
    <div class="game-status" id="game-status">Collect every spark. Use WASD or arrow keys.</div>
  </section>
  <footer class="game-controls">
    <div class="pad" aria-label="Touch controls">
      <button type="button" data-key="ArrowLeft" aria-label="Move left">←</button>
      <button type="button" data-key="ArrowUp" aria-label="Move up">↑</button>
      <button type="button" data-key="ArrowDown" aria-label="Move down">↓</button>
      <button type="button" data-key="ArrowRight" aria-label="Move right">→</button>
    </div>
    <button class="reset" id="reset" type="button">restart run</button>
  </footer>
</main>`,
    },
    {
      path: "styles.css",
      language: "css",
      content: `:root{color-scheme:dark;--ink:#0d0e0c;--panel:#171915;--line:#34372f;--lime:#caff45;--paper:#f3f4ed;--muted:#8e9287}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 0,#252a20 0,#10110f 46%,#090a08 100%);color:var(--paper);font-family:Arial,sans-serif}
button{font:inherit}
.game-shell{width:min(100%,1040px);padding:24px}
.game-header,.game-controls{display:flex;align-items:center;justify-content:space-between;gap:18px}
.eyebrow{color:var(--lime);font:700 10px monospace;letter-spacing:.13em}
h1{margin:6px 0 16px;font-size:clamp(28px,5vw,58px);line-height:.9;letter-spacing:-.06em}
.scoreboard{display:grid;min-width:112px;gap:3px;padding:11px 14px;border:1px solid var(--line);border-radius:10px;background:#11130f;text-align:right}
.scoreboard span{color:var(--muted);font:700 9px monospace;letter-spacing:.1em}.scoreboard strong{font:700 18px monospace}
.stage{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:14px;background:#11130f;box-shadow:0 24px 80px #0008}
canvas{display:block;width:100%;height:auto;aspect-ratio:16/9}
.game-status{position:absolute;right:12px;bottom:12px;left:12px;padding:9px 11px;border:1px solid #ffffff17;border-radius:7px;background:#090a08c9;color:#bdc0b7;font:11px/1.4 monospace;backdrop-filter:blur(8px)}
.game-controls{margin-top:12px}.pad{display:flex;gap:7px}.pad button,.reset{min-width:40px;height:38px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--paper);cursor:pointer}
.pad button:active{border-color:var(--lime);background:var(--lime);color:var(--ink)}.reset{width:auto;padding:0 16px;color:var(--lime);font:700 10px monospace}
@media(max-width:600px){.game-shell{padding:12px}.game-header{align-items:end}.scoreboard{min-width:92px}.game-status{font-size:9px}.game-controls{align-items:stretch}.pad{flex:1}.pad button{flex:1}.reset{padding:0 10px}}`,
    },
    {
      path: "src/app.js",
      language: "javascript",
      content: `const canvas = document.querySelector("#game");
const context = canvas.getContext("2d");
const score = document.querySelector("#score");
const status = document.querySelector("#game-status");
const pressed = new Set();
const player = { x: 120, y: 270, radius: 15, speed: 260 };
const sparkSeeds = [[240,110],[420,190],[610,105],[790,220],[300,410],[555,385],[830,430]];
let sparks = [];
let previousTime = 0;

const resetGame = () => {
  player.x = 120;
  player.y = 270;
  sparks = sparkSeeds.map(([x,y], index) => ({ x, y, radius: 10, phase: index * 0.8, found: false }));
  score.textContent = "0 / " + sparks.length;
  status.textContent = "Collect every spark. Use WASD or arrow keys.";
};

const setKey = (key, active) => {
  const normalized = key.length === 1 ? key.toLowerCase() : key;
  if (active) pressed.add(normalized); else pressed.delete(normalized);
};

document.addEventListener("keydown", (event) => {
  if (["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","w","a","s","d"].includes(event.key)) event.preventDefault();
  setKey(event.key, true);
});
document.addEventListener("keyup", (event) => setKey(event.key, false));
document.querySelectorAll("[data-key]").forEach((button) => {
  const key = button.getAttribute("data-key");
  button.addEventListener("pointerdown", () => setKey(key, true));
  button.addEventListener("pointerup", () => setKey(key, false));
  button.addEventListener("pointercancel", () => setKey(key, false));
  button.addEventListener("pointerleave", () => setKey(key, false));
});
document.querySelector("#reset").addEventListener("click", resetGame);

const update = (delta) => {
  const horizontal = Number(pressed.has("ArrowRight") || pressed.has("d")) - Number(pressed.has("ArrowLeft") || pressed.has("a"));
  const vertical = Number(pressed.has("ArrowDown") || pressed.has("s")) - Number(pressed.has("ArrowUp") || pressed.has("w"));
  const length = Math.hypot(horizontal, vertical) || 1;
  player.x += horizontal / length * player.speed * delta;
  player.y += vertical / length * player.speed * delta;
  player.x = Math.max(player.radius, Math.min(canvas.width - player.radius, player.x));
  player.y = Math.max(player.radius, Math.min(canvas.height - player.radius, player.y));

  for (const spark of sparks) {
    if (!spark.found && Math.hypot(player.x - spark.x, player.y - spark.y) < player.radius + spark.radius + 4) spark.found = true;
  }
  const collected = sparks.filter((spark) => spark.found).length;
  score.textContent = collected + " / " + sparks.length;
  if (collected === sparks.length) status.textContent = "Run complete. Fork this build and invent the next mechanic.";
};

const draw = (time) => {
  context.fillStyle = "#10120e";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#20241c";
  context.lineWidth = 1;
  for (let x = 0; x <= canvas.width; x += 48) { context.beginPath(); context.moveTo(x,0); context.lineTo(x,canvas.height); context.stroke(); }
  for (let y = 0; y <= canvas.height; y += 48) { context.beginPath(); context.moveTo(0,y); context.lineTo(canvas.width,y); context.stroke(); }

  for (const spark of sparks) {
    if (spark.found) continue;
    const pulse = 1 + Math.sin(time / 230 + spark.phase) * 0.18;
    context.beginPath();
    context.arc(spark.x, spark.y, spark.radius * pulse, 0, Math.PI * 2);
    context.fillStyle = "#9d8cff";
    context.shadowColor = "#9d8cff";
    context.shadowBlur = 18;
    context.fill();
  }
  context.shadowBlur = 24;
  context.shadowColor = "#caff45";
  context.fillStyle = "#caff45";
  context.beginPath();
  context.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
  context.fill();
  context.shadowBlur = 0;
};

const frame = (time) => {
  const delta = Math.min((time - previousTime) / 1000, 0.05);
  previousTime = time;
  update(delta);
  draw(time);
  requestAnimationFrame(frame);
};

resetGame();
requestAnimationFrame(frame);`,
    },
    {
      path: "project.make.json",
      language: "json",
      content: JSON.stringify({
        schema: 1,
        kind: "game",
        runtime: "browser-canvas-2d",
        entry: "src/app.js",
        lanes: {
          logic: ["src/**"],
          world: ["world/**"],
          art: ["assets/**"],
          audio: ["audio/**"],
          playtest: ["playtests/**"],
        },
      }, null, 2),
    },
    {
      path: "world/level-01.json",
      language: "json",
      content: JSON.stringify({ name: "Spark field", width: 960, height: 540, goal: "collect-all-sparks" }, null, 2),
    },
    {
      path: "assets/README.md",
      language: "markdown",
      content: "# Art lane\n\nPut sprite concepts, palettes, animation notes, and future uploaded assets here. Asset binaries will be stored separately and referenced by the project manifest.",
    },
    {
      path: "audio/README.md",
      language: "markdown",
      content: "# Audio lane\n\nPlan music, ambience, and sound cues here. Future uploaded audio will live in the project asset store and remain fork-aware.",
    },
    {
      path: "playtests/README.md",
      language: "markdown",
      content: "# Playtest lane\n\nRecord what happened, what felt good, and the smallest mechanic worth changing in the next fork.",
    },
    {
      path: "README.md",
      language: "markdown",
      content: `# ${roomName}\n\nA playable make/room game project. Work in parallel across logic, world, art, audio, and playtest lanes; present the fork; then converge the best build.`,
    },
  ]);
}

export function makeStarterProject(
  roomName: string,
  template: ProjectTemplate = "app",
): ArtifactSourceFile[] {
  if (template === "game") return makeGameStarterProject(roomName);
  return validateArtifactFiles([
    ...sourceFilesFromGenerated(makeStarterSource(roomName)),
    {
      path: "src/app.js",
      language: "javascript",
      content: `const status = document.querySelector("#result");\n\ndocument.addEventListener("change", (event) => {\n  const choice = event.target;\n  if (!(choice instanceof HTMLInputElement) || !status) return;\n  status.dataset.choice = choice.id;\n});`,
    },
    {
      path: "README.md",
      language: "markdown",
      content: `# ${roomName}\n\nA shared make/room project. Edit a file, review the staged diff, then ship it together.`,
    },
    {
      path: "project.make.json",
      language: "json",
      content: JSON.stringify({
        schema: 1,
        kind: "app",
        runtime: "browser",
        entry: "src/app.js",
        lanes: {
          interface: ["index.html", "styles.css", "components/**"],
          logic: ["src/**"],
          data: ["data/**"],
          quality: ["tests/**", "docs/**"],
        },
      }, null, 2),
    },
  ]);
}

export function generatedSourceFromFiles(
  files: ReadonlyArray<Pick<ArtifactSourceFile, "path" | "content">>,
): GeneratedSource {
  const byPath = new Map<string, string>();
  for (const file of files) {
    if (byPath.has(file.path)) {
      throw new Error("A project cannot contain duplicate source paths.");
    }
    byPath.set(file.path, file.content);
  }

  const html = byPath.get("index.html");
  const css = byPath.get("styles.css");
  if (html === undefined || css === undefined) {
    throw new Error("An artifact must contain index.html and styles.css.");
  }
  return { html, css };
}

export function makeStarterSource(roomName: string) {
  return extractArtifactSource(makeStarterArtifact(roomName));
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

export function assembleGeneratedArtifact(source: GeneratedSource, title: string) {
  const html = source.html.trim();
  const css = source.css.trim();

  if (!html || byteLength(html) > 65_536) {
    throw new Error("Generated HTML was empty or too large.");
  }
  if (byteLength(css) > 65_536) {
    throw new Error("Generated CSS exceeded the preview limit.");
  }
  if (byteLength(html) + byteLength(css) > 131_072) {
    throw new Error("The generated artifact exceeded the total preview limit.");
  }

  const forbiddenHtml =
    /<(?:script|style|link|meta|base|iframe|object|embed|form|a|svg|math|template|audio|video|source|track)\b|\son[a-z]+\s*=|\sstyle\s*=|(?:\s|:)\s*(?:src|href)\s*=/i;
  const forbiddenCss = /@import\b|url\s*\(|expression\s*\(|behavior\s*:|-moz-binding\s*:/i;

  if (forbiddenHtml.test(html)) {
    throw new Error("Generated HTML requested a capability that previews do not allow.");
  }
  if (forbiddenCss.test(css)) {
    throw new Error("Generated CSS attempted to load an external asset.");
  }
  const safeTitle = escapeHtml(title.slice(0, 80));
  const safeCss = css.replace(/<\/style/gi, "<\\/style");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${safeTitle}</title>${securityMeta}<style>${safeCss}</style></head><body>${html}</body></html>`;
}

export function assembleArtifactFiles(
  inputFiles: ReadonlyArray<
    Pick<ArtifactSourceFile, "path" | "content"> &
      Partial<Pick<ArtifactSourceFile, "language">>
  >,
  title: string,
) {
  const files = validateArtifactFiles(inputFiles);
  const source = generatedSourceFromFiles(files);
  const base = assembleGeneratedArtifact(source, title);
  const javascript =
    files.find((file) => file.path === "src/app.js")?.content ??
    files.find((file) => file.path === "app.js")?.content ??
    "";
  if (!javascript.trim()) return base;
  const forbiddenJavascript =
    /\b(?:eval|Function|WebAssembly|Worker|SharedWorker|importScripts)\b|\b(?:window|self|globalThis)\s*\.\s*(?:open|parent|top|opener)\b|\bdocument\s*\.\s*cookie\b|\b(?:localStorage|sessionStorage|indexedDB)\b/i;
  if (forbiddenJavascript.test(javascript)) {
    throw new Error("Project JavaScript requested a capability the preview does not allow.");
  }
  const safeJavascript = javascript.replace(/<\/script/gi, "<\\/script");
  const scriptEnabledBase = base.replace(
    "script-src 'none'",
    `script-src 'nonce-${scriptNonce}'; child-src 'none'; worker-src 'none'`,
  );
  return scriptEnabledBase.replace(
    "</body>",
    `<script nonce="${scriptNonce}" data-make-room-entry>${safeJavascript}</script></body>`,
  );
}
