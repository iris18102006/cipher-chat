// Small windows on top of the page (the liked-by list, edit, share, report...), one on top of
// another if need be. Loaded after app.js (el). Escape closes the top one, and Tab stays inside it.

const dialogStack = [];

// openDialog("Title", someNode) gives back { close(), card, body }
function openDialog(title, content, opts) {
  opts = opts || {};
  const overlay = el("div", "dlg-overlay");
  const card = el("div", "dlg-card" + (opts.wide ? " wide" : ""));
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", title);
  const bar = el("div", "dlg-bar");
  const x = el("button", "dlg-x", "\u00d7");
  x.type = "button";
  x.setAttribute("aria-label", "close");
  bar.append(el("span", "dlg-title", title), x);
  const body = el("div", "dlg-body");
  body.append(content);
  card.append(bar, body);
  overlay.append(card);

  const returnFocus = document.activeElement;
  const dlg = {
    card,
    body,
    close() {
      const at = dialogStack.indexOf(dlg);
      if (at === -1) return;
      dialogStack.splice(at, 1);
      overlay.remove();
      if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
      if (opts.onClose) opts.onClose();
    },
  };
  x.onclick = dlg.close;
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) dlg.close();
  });
  card.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const items = [...card.querySelectorAll("button, textarea, input, select, a[href]")].filter((n) => !n.disabled && !n.hidden && n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  document.body.append(overlay);
  dialogStack.push(dlg);
  const first = body.querySelector("textarea, input, select, button") || x;
  first.focus();
  return dlg;
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !dialogStack.length) return;
  e.stopImmediatePropagation();
  dialogStack[dialogStack.length - 1].close();
}, true);

// a button that is a button (type="button" so it never submits a form by accident)
function plainButton(label, onClick, cls) {
  const b = el("button", cls || "", label);
  b.type = "button";
  if (onClick) b.onclick = onClick;
  return b;
}
