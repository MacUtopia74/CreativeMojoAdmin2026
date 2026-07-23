// Client-side legal-numbering utility.
// Backend is the authoritative source of truth (see contract_numbering.py).
// This runs in the browser to give an instant in-editor digital preview.
// The renders that leave the editor (final PDF, issuance, signed copies)
// always use the backend implementation.

const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"];

function letterLabel(idx) {
  let out = "";
  let n = idx;
  while (true) {
    const r = n % 26;
    out = String.fromCharCode(97 + r) + out;
    n = Math.floor(n / 26);
    if (n === 0) break;
    n -= 1;
  }
  return out;
}

function roman(n) {
  const numerals = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"],
    [100, "c"], [90, "xc"], [50, "l"], [40, "xl"],
    [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let out = ""; let x = n;
  for (const [v, s] of numerals) { while (x >= v) { out += s; x -= v; } }
  return out;
}

function clauseLabel(depth, idx) {
  if (depth === 0) return `(${letterLabel(idx)})`;
  if (depth === 1) return `(${roman(idx + 1)})`;
  if (depth === 2) return `(${letterLabel(idx).toUpperCase()})`;
  return `(${idx + 1})`;
}

function stripGeneratedNumbers(container) {
  container.querySelectorAll(".cm-generated-num").forEach((el) => el.remove());
}

function shouldSkip(el) {
  return el.dataset?.numSkip === "true";
}

/**
 * Walk a DOM container and inject <span class="cm-generated-num"> spans
 * at the start of every heading and <ol><li>.
 * Returns the mutated container.
 */
export function applyLegalNumbering(container) {
  if (!container) return container;
  stripGeneratedNumbers(container);
  const counters = [0, 0, 0, 0, 0, 0];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
  const headings = [];
  while (walker.nextNode()) {
    const el = walker.currentNode;
    const tag = el.tagName.toLowerCase();
    if (HEADINGS.includes(tag) && !shouldSkip(el)) headings.push(el);
  }
  for (const el of headings) {
    const level = parseInt(el.tagName.substring(1), 10) - 1;
    counters[level] += 1;
    for (let i = level + 1; i < counters.length; i += 1) counters[i] = 0;
    const parts = [];
    for (let i = 0; i <= level; i += 1) if (counters[i] > 0) parts.push(counters[i]);
    if (!parts.length) continue;
    const span = document.createElement("span");
    span.className = "cm-generated-num";
    span.textContent = `${parts.join(".")}. `;
    el.insertBefore(span, el.firstChild);
  }
  // Ordered lists — depth = number of <ol> ancestors.
  const lists = container.querySelectorAll("ol");
  lists.forEach((ol) => {
    if (shouldSkip(ol)) return;
    let depth = 0;
    let p = ol.parentElement;
    while (p) {
      if (p.tagName?.toLowerCase() === "ol") depth += 1;
      p = p.parentElement;
    }
    const items = Array.from(ol.children).filter((c) => c.tagName?.toLowerCase() === "li");
    items.forEach((li, i) => {
      if (shouldSkip(li)) return;
      const span = document.createElement("span");
      span.className = "cm-generated-num";
      span.textContent = `${clauseLabel(depth, i)} `;
      li.insertBefore(span, li.firstChild);
    });
  });
  return container;
}
