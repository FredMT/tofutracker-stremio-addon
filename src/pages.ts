// The configure page: one HTML document with inline CSS and JS (both carry the
// per-response CSP nonce). The page holds no secrets. It talks to /api/setup/*
// with an unguessable setup id kept in memory.

export type PageBoot = {
  basePath: string;
  /** Present on /{cfg}/configure: the page manages an existing account. */
  cfg: string | null;
  linkHost: string;
};

const escapeJson = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

const CSS = `
:root{color-scheme:light dark;--bg:#fbfaf7;--fg:#1d1b17;--muted:#6b665d;--card:#fff;--line:#e4dfd3;--accent:#2f7d4f;--accent-fg:#fff;--warn:#a4410f}
@media (prefers-color-scheme:dark){:root{--bg:#15130f;--fg:#f0ece3;--muted:#a39d90;--card:#1e1b16;--line:#322e26;--accent:#5bbd84;--accent-fg:#10261a;--warn:#ec9a67}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:640px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:1.6rem;margin:0 0 4px}
h2{font-size:1.05rem;margin:0}
p{margin:8px 0}
.muted{color:var(--muted)}
.lead{color:var(--muted);margin-bottom:24px}
ol{list-style:none;padding:0;margin:0;display:grid;gap:12px}
.step{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.step.off{opacity:.55}
.head{display:flex;align-items:center;gap:10px}
.n{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:50%;background:var(--line);font-size:.85rem;font-weight:600}
.done .n{background:var(--accent);color:var(--accent-fg)}
.body{margin-top:12px}
button,.btn{font:inherit;display:inline-block;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:8px 14px;border-radius:8px;cursor:pointer;text-decoration:none}
button.primary,.btn.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent);font-weight:600}
button:disabled{opacity:.6;cursor:default}
input{font:inherit;width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);margin:4px 0 10px}
label{font-size:.9rem;color:var(--muted)}
.code{font:600 1.8rem/1.2 ui-monospace,Menlo,monospace;letter-spacing:.12em;margin:8px 0}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.tabs button[aria-pressed=true]{border-color:var(--accent);font-weight:600}
.err{color:var(--warn);margin-top:8px}
.ok{color:var(--accent)}
img.qr{width:140px;height:140px;border-radius:8px;background:#fff;padding:6px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.row input{flex:1;min-width:220px;margin:0}
footer{margin-top:28px;font-size:.85rem;color:var(--muted)}
`;

const JS = `
(() => {
  const boot = JSON.parse(document.getElementById("boot").textContent);
  const root = document.getElementById("app");
  const el = (tag, attrs, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
    return node;
  };
  const api = async (path, method, body) => {
    const res = await fetch(boot.basePath + "/api" + path, {
      method,
      headers: body === undefined ? { accept: "application/json" } : { "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) { const e = new Error(data.message || "Something went wrong."); e.code = data.error; throw e; }
    return data;
  };

  let st = null;          // server view of the setup
  let setupId = null;
  let method = "link";    // stremio sign-in tab
  let busy = false;
  let error = { tofu: "", stremio: "", finish: "" };
  let result = null;      // { manifestUrl, installUrl }
  const timers = {};

  const run = async (area, fn) => {
    busy = true; error[area] = ""; render();
    try { st = await fn() || st; } catch (e) { error[area] = e.message; }
    busy = false; render();
  };
  const poll = (kind) => {
    clearTimeout(timers[kind]);
    const s = st && st[kind];
    if (!s || s.state !== "waiting") return;
    timers[kind] = setTimeout(async () => {
      try {
        st = await api("/setup/" + setupId + (kind === "tofu" ? "/tofu/poll" : "/stremio/link/poll"), "GET");
      } catch (e) { error[kind] = e.message; }
      render();
    }, Math.max(1500, s.retryInMs || 3000));
  };

  const tofuStep = () => {
    const s = st.tofu;
    const body = [];
    if (s.state === "linked") {
      body.push(el("p", { class: "ok" }, "Linked" + (s.username ? " as @" + s.username : "") + "."));
      if (boot.cfg) body.push(el("button", { disabled: busy, onclick: () => run("tofu", () => api("/setup/" + setupId + "/tofu/start", "POST")) }, "Link a different account"));
    } else if (s.state === "waiting") {
      body.push(el("p", {}, "Open the link below while signed in to TofuTracker and approve this code."));
      body.push(el("div", { class: "code" }, s.userCode));
      body.push(el("p", {}, el("a", { class: "btn primary", href: s.verificationUrl, target: "_blank", rel: "noopener" }, "Open TofuTracker")));
      body.push(el("p", { class: "muted" }, "Waiting for approval…"));
    } else {
      if (s.state === "expired") body.push(el("p", { class: "err" }, "That code expired."));
      if (s.state === "denied") body.push(el("p", { class: "err" }, "The link request was denied."));
      body.push(el("button", { class: "primary", disabled: busy, onclick: () => run("tofu", () => api("/setup/" + setupId + "/tofu/start", "POST")) }, "Link TofuTracker"));
    }
    if (error.tofu) body.push(el("p", { class: "err" }, error.tofu));
    return body;
  };

  const tab = (id, label) => el("button", { "aria-pressed": String(method === id), onclick: () => { method = id; render(); } }, label);

  const stremioStep = () => {
    const s = st.stremio;
    const body = [];
    if (s.state === "linked") {
      body.push(el("p", { class: "ok" }, "Signed in to Stremio."));
      if (boot.cfg) body.push(el("button", { onclick: () => { st.stremio.state = "idle"; render(); } }, "Sign in again"));
      return body;
    }
    body.push(el("div", { class: "tabs" }, tab("link", "Link code"), tab("password", "Email and password"), tab("key", "Auth key")));
    if (method === "link") {
      if (s.state === "waiting") {
        body.push(el("p", {}, "Open ", el("a", { href: s.link, target: "_blank", rel: "noopener" }, boot.linkHost), " and enter this code. Sign in to Stremio there if asked."));
        body.push(el("div", { class: "code" }, s.code));
        if (s.qr) body.push(el("img", { class: "qr", src: s.qr, alt: "QR code for the Stremio link page" }));
        body.push(el("p", { class: "muted" }, "Waiting for you to enter the code…"));
      } else {
        if (s.state === "expired") body.push(el("p", { class: "err" }, "That code expired."));
        body.push(el("p", { class: "muted" }, "Works for every kind of Stremio account, including Google and Facebook. We never see your password."));
        body.push(el("button", { class: "primary", disabled: busy, onclick: () => run("stremio", () => api("/setup/" + setupId + "/stremio/link/start", "POST")) }, "Get a link code"));
      }
    } else if (method === "password") {
      const email = el("input", { type: "email", autocomplete: "username", required: true });
      const pass = el("input", { type: "password", autocomplete: "current-password", required: true });
      body.push(el("form", { onsubmit: (ev) => { ev.preventDefault(); const p = pass.value; pass.value = ""; run("stremio", () => api("/setup/" + setupId + "/stremio/login", "POST", { email: email.value, password: p })); } },
        el("label", {}, "Stremio email"), email, el("label", {}, "Stremio password"), pass,
        el("button", { class: "primary", type: "submit", disabled: busy }, "Sign in"),
        el("p", { class: "muted" }, "The password is sent to Stremio once to get a key. It is not stored or logged.")));
    } else {
      const key = el("input", { type: "password", autocomplete: "off", spellcheck: "false", required: true });
      body.push(el("form", { onsubmit: (ev) => { ev.preventDefault(); const k = key.value; key.value = ""; run("stremio", () => api("/setup/" + setupId + "/stremio/authkey", "POST", { authKey: k })); } },
        el("label", {}, "Stremio auth key"), key,
        el("button", { class: "primary", type: "submit", disabled: busy }, "Use this key"),
        el("p", { class: "muted" }, "For advanced use. Treat the key like a password; it is stored encrypted.")));
    }
    if (error.stremio) body.push(el("p", { class: "err" }, error.stremio));
    return body;
  };

  const copy = async (text, btn) => {
    try { await navigator.clipboard.writeText(text); btn.textContent = "Copied"; } catch { btn.textContent = "Select and copy"; }
  };

  const finishStep = () => {
    if (result) {
      const url = el("input", { type: "text", readonly: true, value: result.manifestUrl });
      const btn = el("button", { onclick: () => copy(result.manifestUrl, btn) }, "Copy");
      return [
        el("p", { class: "ok" }, "All set. Install the addon in Stremio:"),
        el("p", {}, el("a", { class: "btn primary", href: result.installUrl }, "Install in Stremio")),
        el("p", { class: "muted" }, "Or paste this address into Stremio's addon search box. It is personal to you, so keep it private."),
        el("div", { class: "row" }, url, btn),
        el("p", { class: "muted" }, "The first sync only records your current library, so nothing old is imported."),
      ];
    }
    const body = [el("button", { class: "primary", disabled: busy || !st.ready, onclick: () => run("finish", async () => { const r = await api("/setup/" + setupId + "/finish", "POST"); result = r; return st; }) }, boot.cfg ? "Save changes" : "Create my addon link")];
    if (error.finish) body.push(el("p", { class: "err" }, error.finish));
    return body;
  };

  const step = (n, title, done, off, body) =>
    el("li", { class: "step" + (done ? " done" : "") + (off ? " off" : "") },
      el("div", { class: "head" }, el("span", { class: "n" }, done ? "✓" : String(n)), el("h2", {}, title)),
      off ? null : el("div", { class: "body" }, body));

  const render = () => {
    root.replaceChildren();
    if (!st) { root.append(el("p", { class: "muted" }, error.tofu || "Loading…")); return; }
    if (st.account) {
      const label = { ok: "Working", needs_stremio_signin: "Needs a new Stremio sign-in", needs_tofutracker_relink: "Needs TofuTracker to be linked again" }[st.account.status] || st.account.status;
      root.append(el("p", {}, "Status: ", el("strong", {}, label)));
    }
    root.append(el("ol", {},
      step(1, "Link your TofuTracker account", st.tofu.state === "linked", false, tofuStep()),
      step(2, "Sign in to Stremio", st.stremio.state === "linked", false, stremioStep()),
      step(3, boot.cfg ? "Save" : "Install", !!result, !st.ready && !result, finishStep())));
    if (boot.cfg) {
      const un = el("button", { disabled: busy, onclick: async () => {
        if (!confirm("Stop tracking? Your TofuTracker library keeps what was already added.")) return;
        try { await api("/account/" + boot.cfg + "/unlink", "POST"); root.replaceChildren(el("p", {}, "Unlinked. You can remove the addon from Stremio.")); } catch (e) { error.finish = e.message; render(); }
      } }, "Unlink and stop tracking");
      root.append(el("p", {}, un));
    }
    poll("tofu"); poll("stremio");
  };

  (async () => {
    try { st = await api("/setup", "POST", { cfg: boot.cfg }); setupId = st.setupId; }
    catch (e) { error.tofu = e.message; }
    render();
  })();
})();
`;

export const renderConfigurePage = (nonce: string, boot: PageBoot): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>TofuTracker for Stremio</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<main>
<h1>TofuTracker for Stremio</h1>
<p class="lead">Link your accounts once. Stremio then adds what you watch to your TofuTracker library.</p>
<div id="app"><noscript><p>This page needs JavaScript.</p></noscript></div>
<footer>Open source (MIT). We store your Stremio sign-in encrypted and use it only to read your library. Unlink here at any time.</footer>
</main>
<script type="application/json" id="boot">${escapeJson(boot)}</script>
<script nonce="${nonce}">${JS}</script>
</body>
</html>`;
