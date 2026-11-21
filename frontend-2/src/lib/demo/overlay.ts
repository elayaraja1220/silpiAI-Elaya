/**
 * The demo overlay: what makes a preview obviously a demo, and keeps it read-only. It is added to every HTML page the demo
 * serves, whatever framework built the site.
 */

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export type OverlayMeta = { label: string; expires: string };

/** The script the pages load from /__demo/overlay.js. Plain browser JavaScript, no dependencies. */
export function overlayScript(): string {
  return `(function () {
  var tag = document.currentScript;
  var label = (tag && tag.getAttribute("data-label")) || "";
  var expires = (tag && tag.getAttribute("data-expires")) || "";

  function toast(message) {
    var old = document.getElementById("silpi-demo-toast");
    if (old) old.remove();
    var t = document.createElement("div");
    t.id = "silpi-demo-toast";
    t.setAttribute("role", "status");
    t.style.cssText = "position:fixed;left:50%;bottom:56px;transform:translateX(-50%);z-index:2147483647;background:#1f2937;color:#fff;padding:10px 16px;border-radius:10px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35);max-width:90vw;text-align:center";
    t.textContent = message;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  }
  var OFF = "This is a demo: forms and actions that send data are switched off.";

  // Everything that would send data is switched off.
  document.addEventListener("submit", function (e) { e.preventDefault(); e.stopPropagation(); toast(OFF); }, true);
  if (window.fetch) {
    var realFetch = window.fetch;
    window.fetch = function (input, init) {
      var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") { toast(OFF); return Promise.resolve(new Response(JSON.stringify({ demo: true, message: OFF }), { status: 403, headers: { "Content-Type": "application/json" } })); }
      return realFetch.apply(this, arguments);
    };
  }
  if (window.XMLHttpRequest) {
    var open = XMLHttpRequest.prototype.open;
    var send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method) { this.__silpiMethod = String(method || "GET").toUpperCase(); return open.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      if (this.__silpiMethod && this.__silpiMethod !== "GET" && this.__silpiMethod !== "HEAD") { var x = this; toast(OFF); setTimeout(function () { x.dispatchEvent(new Event("error")); }, 0); return; }
      return send.apply(this, arguments);
    };
  }
  if (navigator.sendBeacon) navigator.sendBeacon = function () { return false; };

  function mount() {
    if (document.querySelector("[data-silpi-demo]")) return;
    var text = "DEMO PREVIEW \\u00b7 not the final website" + (label ? " \\u00b7 prepared for " + label : "") + (expires ? " \\u00b7 ends " + expires : "");
    var bar = document.createElement("div");
    bar.setAttribute("data-silpi-demo", "bar");
    bar.textContent = text;
    bar.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#111827;color:#fde68a;text-align:center;padding:8px 12px;font:600 12px/1.3 system-ui,sans-serif;letter-spacing:.04em;pointer-events:none";
    var mark = (label || "DEMO").replace(/[<>&"']/g, "");
    var svg = "<svg xmlns='http://www.w3.org/2000/svg' width='360' height='240'><text x='20' y='140' transform='rotate(-24 180 120)' font-family='sans-serif' font-size='22' font-weight='700' fill='black'>DEMO \\u00b7 " + mark + "</text></svg>";
    var wm = document.createElement("div");
    wm.setAttribute("data-silpi-demo", "watermark");
    wm.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none;opacity:.06;background-image:url(\\"data:image/svg+xml;utf8," + encodeURIComponent(svg) + "\\")";
    document.body.appendChild(wm);
    document.body.appendChild(bar);
  }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
})();
`;
}

/** Adds the demo script (and a noindex tag) to an HTML page. A page without </body> gets the script at the end. */
export function injectOverlay(html: string, meta: OverlayMeta): string {
  if (html.includes("data-silpi-demo-script")) return html;
  const script = `<script src="/__demo/overlay.js" data-silpi-demo-script data-label="${escapeAttr(meta.label)}" data-expires="${escapeAttr(meta.expires)}"></script>`;
  let out = html;
  if (!/<meta[^>]+name=["']robots["']/i.test(out)) {
    out = /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (m) => `${m}<meta name="robots" content="noindex,nofollow">`) : `<meta name="robots" content="noindex,nofollow">${out}`;
  }
  const close = out.search(/<\/body\s*>/i);
  if (close >= 0) {
    const last = out.toLowerCase().lastIndexOf("</body");
    return `${out.slice(0, last)}${script}${out.slice(last)}`;
  }
  return out + script;
}
