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
