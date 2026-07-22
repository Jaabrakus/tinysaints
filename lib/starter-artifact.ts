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

export function makeStarterProject(roomName: string): ArtifactSourceFile[] {
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
