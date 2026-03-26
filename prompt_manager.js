// ─── Constants ────────────────────────────────────────────────────────────────
const PROMPT_W   = 700;
const PROMPT_H   = 420;
const GAP_X      = 96;
const GAP_Y      = 96;
const PAD        = 48;
const BACK_PAD   = 200; // extra canvas padding on each side for back-edge arcs
const MAX_TITLE  = 40;
const ZOOM_STEPS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2];

// ─── State ────────────────────────────────────────────────────────────────────
const prompts     = [{ id: uid(), row: 0, slot: 0 }];
const connections = [];
let drag            = null;
let zoomLevel       = 1;
let measuredRowH    = {};
let newPromptId     = null;
let newBtnKey       = null;   // "right-{row}" | "row-{row}"
let isInitialRender = true;
let lastFocusedText = null;

// ─── Utilities ────────────────────────────────────────────────────────────────
function uid()      { return Math.random().toString(36).slice(2, 9); }
function el(id)     { return document.getElementById(id); }
function svgEl(tag) { return document.createElementNS("http://www.w3.org/2000/svg", tag); }
function getMain()  { return el("main"); }
function getCanvas(){ return el("canvas"); }
function getSvg()   { return el("connections-svg"); }

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function cursorToEnd(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function clientToCanvas(cx, cy) {
  const rect = getCanvas().getBoundingClientRect();
  return { x: (cx - rect.left) / zoomLevel, y: (cy - rect.top) / zoomLevel };
}


function inRow(row) {
  return prompts.filter(p => p.row === row).sort((a, b) => a.slot - b.slot);
}

// ─── Layout ───────────────────────────────────────────────────────────────────
function computeLayout() {
  const maxRow = Math.max(...prompts.map(p => p.row));

  const rowTop = [PAD];
  for (let r = 1; r <= maxRow; r++)
    rowTop[r] = rowTop[r - 1] + (measuredRowH[r - 1] ?? PROMPT_H) + GAP_Y;

  function slotsForRow(row) {
    const count  = inRow(row).length;
    const totalW = count * PROMPT_W + (count - 1) * GAP_X;
    const startX = -totalW / 2;
    return Array.from({ length: count }, (_, i) => startX + i * (PROMPT_W + GAP_X));
  }

  let minX = Infinity, maxX = -Infinity, maxBottom = 0;
  for (let r = 0; r <= maxRow; r++) {
    const h = measuredRowH[r] ?? PROMPT_H;
    slotsForRow(r).forEach(x => {
      minX      = Math.min(minX, x);
      maxX      = Math.max(maxX, x + PROMPT_W);
      maxBottom = Math.max(maxBottom, rowTop[r] + h);
    });
  }

  // BACK_PAD reserves space on both sides for back-edge arcs so they never clip
  const shift   = PAD + BACK_PAD - minX;
  const canvasW = maxX + shift + PAD + BACK_PAD;
  const canvasH = maxBottom + PAD * 3;
  return { maxRow, rowTop, slotsForRow, shift, canvasW, canvasH };
}

function addBelow(sourceRow) {
  const nextRow = sourceRow + 1;
  const p = { id: uid(), row: nextRow, slot: inRow(nextRow).length };
  newPromptId = p.id;
  newBtnKey   = `row-${nextRow}`;
  prompts.push(p);
  render();
}

function addSibling(row) {
  const p = { id: uid(), row, slot: inRow(row).length };
  newPromptId = p.id;
  newBtnKey   = null;
  prompts.push(p);
  measuredRowH = {};
  render();
}

function deletePrompt(id) {
  if (prompts.length === 1) return;
  const idx = prompts.findIndex(p => p.id === id);
  if (idx === -1) return;
  prompts.splice(idx, 1);

  for (let i = connections.length - 1; i >= 0; i--) {
    if (connections[i].fromId === id || connections[i].toId === id)
      connections.splice(i, 1);
  }

  const uniqueRows = [...new Set(prompts.map(p => p.row))].sort((a, b) => a - b);
  uniqueRows.forEach((oldRow, newRow) => {
    prompts
      .filter(p => p.row === oldRow)
      .sort((a, b) => a.slot - b.slot)
      .forEach((p, slot) => { p.row = newRow; p.slot = slot; });
  });

  measuredRowH = {};
  render();
}

// ─── Row-level add buttons ────────────────────────────────────────────────────
const BTN_SVG = `<svg width="16" height="16" viewBox="0 0 20 20" fill="none">
  <line x1="10" y1="2" x2="10" y2="18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  <line x1="2" y1="10" x2="18" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;

function rowBtnPositions(r, rowTop, slotsForRow, shift) {
  const slots    = slotsForRow(r);
  const rowH     = measuredRowH[r] ?? PROMPT_H;
  const rowRight = slots[slots.length - 1] + shift + PROMPT_W;
  const rowMidY  = rowTop[r] + rowH / 2;
  const rowBotY  = rowTop[r] + rowH + GAP_Y / 2;
  const rowMidX  = (slots[0] + shift + rowRight) / 2;
  const rightX   = rowRight + GAP_X / 2;
  return { rowMidY, rowBotY, rowMidX, rightX };
}

function makeAddBtn(className, row, label, x, y, isNew, onClick) {
  const btn = document.createElement("button");
  btn.className     = `add-prompt-btn ${className}${isNew ? " is-new" : ""}`;
  btn.dataset.row   = row;
  btn.setAttribute("aria-label", label);
  btn.style.cssText = `position:absolute;left:${x}px;top:${y}px;transform:translate(-50%,-50%);z-index:2;`;
  btn.innerHTML     = BTN_SVG;
  btn.addEventListener("click", onClick);
  if (isNew) btn.addEventListener("animationend", () => btn.classList.remove("is-new"), { once: true });
  return btn;
}

function buildRowAddButtons(canvas, maxRow, rowTop, slotsForRow, shift) {
  for (let r = 0; r <= maxRow; r++) {
    if (!inRow(r).length) continue;
    const { rowMidY, rowBotY, rowMidX, rightX } = rowBtnPositions(r, rowTop, slotsForRow, shift);
    const isNewRow = newBtnKey === `row-${r}`;

    canvas.appendChild(makeAddBtn("add-right-btn", r, "Add block to row", rightX, rowMidY, isNewRow, () => addSibling(r)));

    if (r === maxRow)
      canvas.appendChild(makeAddBtn("add-bottom-btn", r, "Add row below", rowMidX, rowBotY, isNewRow, () => addBelow(r)));
  }
  newBtnKey = null;
}

function repositionRowAddButtons() {
  const canvas = getCanvas();
  if (!canvas) return;
  const maxRow = Math.max(...prompts.map(p => p.row));

  const rowTop = [PAD];
  for (let r = 1; r <= maxRow; r++)
    rowTop[r] = rowTop[r - 1] + (measuredRowH[r - 1] ?? PROMPT_H) + GAP_Y;

  function slotsForRow(row) {
    const count  = inRow(row).length;
    const totalW = count * PROMPT_W + (count - 1) * GAP_X;
    const startX = -totalW / 2;
    return Array.from({ length: count }, (_, i) => startX + i * (PROMPT_W + GAP_X));
  }

  let minX = Infinity;
  for (let r = 0; r <= maxRow; r++) {
    const slots = slotsForRow(r);
    if (slots.length) minX = Math.min(minX, slots[0]);
  }
  const shift = PAD + BACK_PAD - minX;

  canvas.querySelectorAll(".add-right-btn, .add-bottom-btn").forEach(btn => {
    const r = parseInt(btn.dataset.row, 10);
    if (!inRow(r).length) return;
    const { rowMidY, rowBotY, rowMidX, rightX } = rowBtnPositions(r, rowTop, slotsForRow, shift);
    if (btn.classList.contains("add-right-btn")) {
      btn.style.left = rightX + "px";
      btn.style.top  = rowMidY + "px";
    } else {
      btn.style.left = rowMidX + "px";
      btn.style.top  = rowBotY + "px";
    }
  });
}

// ─── Render ───────────────────────────────────────────────────────────────────
function render() {
  const main = getMain();
  const scrollLeft = main.scrollLeft;
  const scrollTop  = main.scrollTop;

  // Snapshot editable content before wiping DOM
  const state = {};
  main.querySelectorAll(".prompt-wrapper[data-id]").forEach(w => {
    state[w.dataset.id] = {
      title: w.querySelector(".prompt-title-text")?.innerText || "Untitled Prompt",
      html:  w.querySelector(".prompt-text")?.innerHTML       || "",
    };
  });

  main.innerHTML = "";

  const spacer = document.createElement("div");
  spacer.id = "canvas-spacer";
  spacer.style.cssText = "position:relative;";
  main.appendChild(spacer);

  const canvas = document.createElement("div");
  canvas.id = "canvas";
  canvas.style.cssText = "position:absolute;top:0;left:0;transform-origin:top left;";
  spacer.appendChild(canvas);

  const svg = svgEl("svg");
  svg.id = "connections-svg";
  svg.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:0;";
  canvas.appendChild(svg);

  const { maxRow, rowTop, slotsForRow, shift, canvasW, canvasH } = computeLayout();
  canvas.style.width  = canvasW + "px";
  canvas.style.height = canvasH + "px";

  prompts.forEach(p => {
    const left  = slotsForRow(p.row)[p.slot] + shift;
    const saved = state[p.id] || {};
    const w = buildWrapper(p, saved.title || "Untitled Prompt", saved.html || "", left, rowTop[p.row]);
    canvas.appendChild(w);
    if (p.id === newPromptId) {
      w.classList.add("is-new");
      newPromptId = null;
    }
    initPrompt(w);
    initDragConnect(w, p.id);
  });

  buildRowAddButtons(canvas, maxRow, rowTop, slotsForRow, shift);

  const ro = new ResizeObserver(() => repositionRows());
  canvas.querySelectorAll(".prompt-wrapper[data-id]").forEach(w => ro.observe(w));

  applyZoom();
  main.scrollLeft = scrollLeft;
  main.scrollTop  = scrollTop;
  renderConnections();

  requestAnimationFrame(() => {
    // Measure row heights
    for (let r = 0; r <= maxRow; r++) {
      const sel = inRow(r).map(p => `.prompt-wrapper[data-id="${p.id}"]`).join(",");
      let maxH = 0;
      if (sel) canvas.querySelectorAll(sel).forEach(e => { maxH = Math.max(maxH, e.offsetHeight); });
      if (maxH > 0) measuredRowH[r] = maxH;
    }
    let bottom = 0;
    canvas.querySelectorAll(".prompt-wrapper[data-id]").forEach(e => {
      bottom = Math.max(bottom, e.offsetTop + e.offsetHeight);
    });
    if (bottom + PAD * 3 > canvasH) canvas.style.height = (bottom + PAD * 3) + "px";
    updateSpacerSize();
    repositionRowAddButtons();
    renderConnections();

    // Stagger entry animation on first load only
    if (isInitialRender) {
      isInitialRender = false;
      const wrappers = [...canvas.querySelectorAll(".prompt-wrapper[data-id]")];
      wrappers.forEach(w => { w.style.opacity = "0"; });
      wrappers.forEach((w, i) => {
        setTimeout(() => {
          w.style.opacity = "";
          w.classList.add("is-new");
          w.addEventListener("animationend", () => w.classList.remove("is-new"), { once: true });
        }, i * 120);
      });
    }
  });
}

function updateSpacerSize(animate = false) {
  const canvas = getCanvas();
  const spacer = el("canvas-spacer");
  const main   = getMain();
  if (!canvas || !spacer) return;

  const scaledW    = (parseFloat(canvas.style.width)  || canvas.offsetWidth)  * zoomLevel;
  const scaledH    = (parseFloat(canvas.style.height) || canvas.offsetHeight) * zoomLevel;
  const sidebarW   = (el("sidebar")?.classList.contains("is-open") ? 320 : 48) + 24;
  const leftOffset = sidebarW + Math.max(0, Math.round((main.clientWidth - sidebarW) / 2 - scaledW / 2));

  canvas.style.transition = animate ? "left 0.3s cubic-bezier(0.22, 1, 0.36, 1)" : "";
  canvas.style.left       = leftOffset + "px";
  spacer.style.width      = Math.max(main.clientWidth, scaledW + leftOffset + 24) + "px";
  spacer.style.height     = Math.max(main.clientHeight, scaledH) + "px";
}

function expandSpacerForLabels() {
  const svg    = getSvg();
  const canvas = getCanvas();
  const spacer = el("canvas-spacer");
  const main   = getMain();
  if (!svg || !canvas || !spacer) return;

  const LABEL_HALF_W = 100 / zoomLevel;
  const LABEL_HALF_H = 20  / zoomLevel;

  let maxRight  = parseFloat(canvas.style.width)  || 0;
  let maxBottom = parseFloat(canvas.style.height) || 0;

  canvas.querySelectorAll(".conn-label-node").forEach(node => {
    const x = parseFloat(node.style.left) || 0;
    const y = parseFloat(node.style.top)  || 0;
    maxRight  = Math.max(maxRight,  x + LABEL_HALF_W + PAD);
    maxBottom = Math.max(maxBottom, y + LABEL_HALF_H + PAD);
  });

  if (maxRight  > parseFloat(canvas.style.width))  canvas.style.width  = maxRight  + "px";
  if (maxBottom > parseFloat(canvas.style.height)) canvas.style.height = maxBottom + "px";

  updateSpacerSize();
}

function repositionRows() {
  const canvas = getCanvas();
  if (!canvas) return;
  const maxRow = Math.max(...prompts.map(p => p.row));

  for (let r = 0; r <= maxRow; r++) {
    let maxH = 0;
    inRow(r).forEach(p => {
      const w = canvas.querySelector(`.prompt-wrapper[data-id="${p.id}"]`);
      if (w) maxH = Math.max(maxH, w.offsetHeight);
    });
    if (maxH > 0) measuredRowH[r] = maxH;
  }

  const rowTop = [PAD];
  for (let r = 1; r <= maxRow; r++)
    rowTop[r] = rowTop[r - 1] + (measuredRowH[r - 1] ?? PROMPT_H) + GAP_Y;

  prompts.forEach(p => {
    const w = canvas.querySelector(`.prompt-wrapper[data-id="${p.id}"]`);
    if (w) w.style.top = rowTop[p.row] + "px";
  });

  let bottom = 0;
  canvas.querySelectorAll(".prompt-wrapper[data-id]").forEach(w => {
    bottom = Math.max(bottom, w.offsetTop + w.offsetHeight);
  });
  canvas.style.height = (bottom + PAD * 3) + "px";
  updateSpacerSize();
  repositionRowAddButtons();
  renderConnections();
}

// ─── Build wrapper DOM ────────────────────────────────────────────────────────
function buildWrapper(p, title, html, left, top) {
  const w = document.createElement("div");
  w.className     = "prompt-wrapper";
  w.dataset.id    = p.id;
  w.style.cssText = `left:${left}px;top:${top}px;width:${PROMPT_W}px;z-index:1;`;

  w.innerHTML = `
    <div class="prompt">
      <div class="prompt-header">
        <div class="prompt-title">
          <h6 class="prompt-title-text">${escHtml(title)}</h6>
        </div>
        <div class="prompt-header-right">
          <div class="character-count"><h6 class="char-count">0 characters</h6></div>

          <div class="delete-btn" title="Delete prompt">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <line x1="1" y1="1" x2="11" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <line x1="11" y1="1" x2="1" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </div>
        </div>
      </div>
      <div class="prompt-block">
        <div class="edge-dot edge-dot--top" title="Drag to connect"></div>
        <div class="edge-dot edge-dot--bottom" title="Drag to connect"></div>
        <div class="prompt-text" contenteditable="true"
             data-placeholder="Write your prompt here..."
             spellcheck="true">${html}</div>
      </div>
    </div>`;

  w.querySelector(".delete-btn").addEventListener("click", () => deletePrompt(p.id));
  return w;
}

// ─── Prompt interactions ──────────────────────────────────────────────────────
function initPrompt(wrapper) {
  const textEl    = wrapper.querySelector(".prompt-text");
  const countEl   = wrapper.querySelector(".char-count");
  const titleWrap = wrapper.querySelector(".prompt-title");
  const titleEl   = wrapper.querySelector(".prompt-title-text");

  textEl.addEventListener("focus", () => { lastFocusedText = textEl; });

  // padSpans: guarantees all 4 cursor positions around every chip.
  // Between two adjacent chips we need TWO ​ chars in the text node —
  // one serves as [chip1]↓ and the other as ↓[chip2].
  // Inside each span, a leading ​ makes [↓chip] reachable.
  function padSpans() {
    Array.from(textEl.querySelectorAll(".block-phrase")).forEach(span => {
      // ── Outside before ────────────────────────────────────────────────
      const prev = span.previousSibling;
      if (!prev || prev.nodeType !== Node.TEXT_NODE) {
        span.parentNode.insertBefore(document.createTextNode("\u200B"), span);
      } else if (prev.nodeType === Node.TEXT_NODE && prev.nodeValue.replace(/\u200B/g,"") === "") {
        // It's a pure-ZWS node shared with a preceding span — ensure at least 2 chars
        // so both [chip1]↓ and ↓[chip2] have their own slot
        if (prev.nodeValue.length < 2) prev.nodeValue = "\u200B\u200B";
      }

      // ── Outside after ─────────────────────────────────────────────────
      const next = span.nextSibling;
      if (!next || next.nodeType !== Node.TEXT_NODE) {
        span.parentNode.insertBefore(document.createTextNode("\u200B"), next || null);
      } else if (next.nodeType === Node.TEXT_NODE && next.nodeValue.replace(/\u200B/g,"") === "") {
        if (next.nodeValue.length < 2) next.nodeValue = "\u200B\u200B";
      }

      // ── Inside leading ​ so [↓chip] is reachable ─────────────────
      const first = span.firstChild;
      if (!first) {
        span.appendChild(document.createTextNode("\u200B"));
      } else if (first.nodeType === Node.TEXT_NODE && !first.nodeValue.startsWith("\u200B")) {
        first.nodeValue = "\u200B" + first.nodeValue;
      }
    });
  }


  let dropIndicator = null;

  function getDropRange(x, y) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (!pos) return null;
      const r = document.createRange();
      r.setStart(pos.offsetNode, pos.offset);
      r.collapse(true);
      return r;
    }
    return null;
  }

  function showDropIndicator(range) {
    removeDropIndicator();
    if (!range) return;
    const rect      = range.getClientRects()[0] || range.getBoundingClientRect();
    const blockRect = textEl.closest(".prompt-block").getBoundingClientRect();
    dropIndicator = document.createElement("div");
    dropIndicator.className = "drop-indicator";
    dropIndicator.style.left   = ((rect.left - blockRect.left) / zoomLevel) + "px";
    dropIndicator.style.top    = ((rect.top  - blockRect.top)  / zoomLevel) + "px";
    dropIndicator.style.height = ((rect.height || 24) / zoomLevel) + "px";
    dropIndicator.style.setProperty("--ind-color", window.__dragColor || "#000");
    textEl.closest(".prompt-block").appendChild(dropIndicator);
  }

  function removeDropIndicator() {
    if (dropIndicator) { dropIndicator.remove(); dropIndicator = null; }
  }

  textEl.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("application/x-docublock-phrase")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    showDropIndicator(getDropRange(e.clientX, e.clientY));
  });

  textEl.addEventListener("dragleave", (e) => {
    if (!textEl.contains(e.relatedTarget)) removeDropIndicator();
  });

  textEl.addEventListener("drop", (e) => {
    if (!e.dataTransfer.types.includes("application/x-docublock-phrase")) return;
    e.preventDefault();
    removeDropIndicator();
    const phrase = e.dataTransfer.getData("application/x-docublock-phrase");
    const color  = e.dataTransfer.getData("application/x-docublock-color");
    if (!phrase) return;

    const range = getDropRange(e.clientX, e.clientY);
    const span  = document.createElement("span");
    span.className = "block-phrase";
    span.style.setProperty("--phrase-color", color);
    span.textContent = phrase;

    if (range && textEl.contains(range.commonAncestorContainer)) {
      range.deleteContents();
      range.insertNode(span);
    } else {
      textEl.appendChild(span);
    }

    padSpans();

    // Place cursor after the span ([chip]↓)
    const afterNode = span.nextSibling;
    const r = document.createRange();
    r.setStart(afterNode, 1); // offset 1 = after the first ​ = [chip]↓ slot
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);

    textEl.dispatchEvent(new Event("input", { bubbles: true }));
  });

  const updateCount = () => {
    const len = textEl.innerText.replace(/\n$/, "").length;
    countEl.textContent = `${len} character${len === 1 ? "" : "s"}`;
    if (!textEl.innerText.trim()) textEl.innerHTML = "";
  };

  textEl.addEventListener("keydown", (e) => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
    const { startContainer, startOffset } = sel.getRangeAt(0);

    if (e.key === "Backspace") {
      let prev = startContainer === textEl
        ? textEl.childNodes[startOffset - 1]
        : startOffset === 0 ? startContainer.previousSibling : null;
      if (prev && prev.nodeType === Node.ELEMENT_NODE && prev.classList.contains("block-phrase")) {
        e.preventDefault();
        const before = prev.previousSibling;
        prev.remove();
        if (before && before.nodeType === Node.TEXT_NODE) {
          const r = document.createRange(); r.setStart(before, before.length); r.collapse(true);
          sel.removeAllRanges(); sel.addRange(r);
        }
        updateCount(); return;
      }
    }

    if (e.key === "Delete") {
      let next = startContainer === textEl
        ? textEl.childNodes[startOffset]
        : startOffset === startContainer.length ? startContainer.nextSibling : null;
      if (next && next.nodeType === Node.ELEMENT_NODE && next.classList.contains("block-phrase")) {
        e.preventDefault();
        const after = next.nextSibling;
        next.remove();
        if (after && after.nodeType === Node.TEXT_NODE) {
          const r = document.createRange(); r.setStart(after, 0); r.collapse(true);
          sel.removeAllRanges(); sel.addRange(r);
        }
        updateCount(); return;
      }
    }
  });

  textEl.addEventListener("input", updateCount);
  textEl.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text/plain") || "";
    if (document.queryCommandSupported?.("insertText")) {
      document.execCommand("insertText", false, text);
    } else {
      const sel = window.getSelection();
      if (!sel?.rangeCount) return;
      sel.deleteFromDocument();
      sel.getRangeAt(0).insertNode(document.createTextNode(text));
      sel.collapseToEnd();
    }
  });
  updateCount();

  const startEdit  = () => {
    titleEl.contentEditable = "true";
    titleWrap.classList.add("editing");
    titleEl.focus();
    cursorToEnd(titleEl);
  };
  const finishEdit = () => {
    titleEl.contentEditable = "false";
    titleWrap.classList.remove("editing");
    if (!titleEl.innerText.trim()) titleEl.innerText = "Untitled Prompt";
  };
  const enforceLimit = () => {
    if (titleEl.innerText.length > MAX_TITLE) {
      titleEl.innerText = titleEl.innerText.slice(0, MAX_TITLE);
      cursorToEnd(titleEl);
    }
  };

  const NAV_KEYS = ["Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Tab"];

  titleEl.addEventListener("dblclick", startEdit);
  titleEl.addEventListener("blur",  () => { enforceLimit(); finishEdit(); });
  titleEl.addEventListener("input", enforceLimit);
  titleEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); enforceLimit(); finishEdit(); return; }
    if (titleEl.innerText.length >= MAX_TITLE && !NAV_KEYS.includes(e.key) && !e.ctrlKey && !e.metaKey)
      e.preventDefault();
  });
  titleEl.addEventListener("paste", (e) => {
    e.preventDefault();
    const pasted    = (e.clipboardData || window.clipboardData).getData("text/plain") || "";
    const remaining = MAX_TITLE - titleEl.innerText.length;
    document.execCommand("insertText", false, pasted.slice(0, Math.max(0, remaining)));
  });
}

// ─── Connections ──────────────────────────────────────────────────────────────
function makePath(attrs) {
  const p = svgEl("path");
  Object.entries(attrs).forEach(([k, v]) => p.setAttribute(k, v));
  return p;
}

function ensureMarkers(svg) {
  if (svg.querySelector("#arrowhead")) return;
  const defs = svgEl("defs");
  const makeMarker = (id, color) => {
    const m = svgEl("marker");
    [["id", id], ["markerWidth", "8"], ["markerHeight", "8"], ["refX", "4"], ["refY", "3"], ["orient", "auto"]]
      .forEach(([k, v]) => m.setAttribute(k, v));
    m.appendChild(makePath({ d: "M 0 0 L 4 3 L 0 6 Z", fill: color }));
    return m;
  };
  defs.appendChild(makeMarker("arrowhead",         "#000000"));
  defs.appendChild(makeMarker("arrowhead-hover",   "#ff3333"));
  defs.appendChild(makeMarker("arrowhead-preview", "#cccccc"));
  svg.appendChild(defs);
}

// ─── Connection geometry ──────────────────────────────────────────────────────

function blockRect(wrapperEl) {
  const block = wrapperEl.querySelector('.prompt-block') || wrapperEl;
  const br = block.getBoundingClientRect();
  const cr = getCanvas().getBoundingClientRect();
  const x = (br.left - cr.left) / zoomLevel;
  const y = (br.top  - cr.top)  / zoomLevel;
  const w =  br.width  / zoomLevel;
  const h =  br.height / zoomLevel;
  return { x, y, w, h, cx:x+w/2, cy:y+h/2,
    top:{x:x+w/2,y:y}, bottom:{x:x+w/2,y:y+h},
    left:{x:x,y:y+h/2}, right:{x:x+w,y:y+h/2} };
}

function dotPt(rect, side) {
  return rect[side];
}

// Rounds corners of an orthogonal SVG path string by replacing each
// L→L corner with a quarter-circle arc of radius r.
function roundPath(d, r) {
  // Parse all M/L commands into points
  const pts = [];
  const re = /([ML])\s*([\d.-]+)\s+([\d.-]+)/g;
  let m;
  while ((m = re.exec(d)) !== null)
    pts.push({ cmd: m[1], x: parseFloat(m[2]), y: parseFloat(m[3]) });
  if (pts.length < 2) return d;

  let out = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const cur  = pts[i];
    const next = pts[i + 1];

    if (!next) { out += ` L ${cur.x} ${cur.y}`; continue; }

    // Incoming direction
    const idx = Math.sign(cur.x - prev.x);
    const idy = Math.sign(cur.y - prev.y);
    // Outgoing direction
    const odx = Math.sign(next.x - cur.x);
    const ody = Math.sign(next.y - cur.y);

    // No corner (straight line) — just draw to cur
    if (idx === odx && idy === ody) { out += ` L ${cur.x} ${cur.y}`; continue; }

    // Clamp r to half the segment lengths so arc never overshoots
    const seg1 = Math.abs(idx ? cur.x - prev.x : cur.y - prev.y);
    const seg2 = Math.abs(odx ? next.x - cur.x : next.y - cur.y);
    const cr   = Math.min(r, seg1 / 2, seg2 / 2);
    if (cr < 1) { out += ` L ${cur.x} ${cur.y}`; continue; }

    // Point where line stops before corner
    const bx = cur.x - idx * cr;
    const by = cur.y - idy * cr;
    // Point where arc ends (start of next segment)
    const ax = cur.x + odx * cr;
    const ay = cur.y + ody * cr;

    // Sweep: 1 = clockwise, 0 = counter-clockwise
    // Cross product of incoming × outgoing: positive = CW
    const cross = idx * ody - idy * odx;
    const sweep = cross > 0 ? 1 : 0;

    out += ` L ${bx} ${by} A ${cr} ${cr} 0 0 ${sweep} ${ax} ${ay}`;
  }
  return out;
}

// ─── renderConnections ────────────────────────────────────────────────────────
function renderConnections() {
  const svg = getSvg();
  if (!svg) return;
  ensureMarkers(svg);
  svg.querySelectorAll('.conn-group,.conn-label-fo').forEach(g => g.remove());
  getCanvas()?.querySelectorAll('.conn-label-node').forEach(n => n.remove());
  const canvas = getCanvas();
  if (!canvas) return;

  const rowMap = {};
  canvas.querySelectorAll('.prompt-wrapper[data-id]').forEach(w => {
    const p = prompts.find(q => q.id === w.dataset.id);
    if (!p) return;
    const r = blockRect(w);
    if (!rowMap[p.row]) rowMap[p.row] = { minX:Infinity, maxX:-Infinity, minY:Infinity, maxY:-Infinity };
    rowMap[p.row].minX = Math.min(rowMap[p.row].minX, r.x);
    rowMap[p.row].maxX = Math.max(rowMap[p.row].maxX, r.x + r.w);
    rowMap[p.row].minY = Math.min(rowMap[p.row].minY, r.y);
    rowMap[p.row].maxY = Math.max(rowMap[p.row].maxY, r.y + r.h);
  });

  let fieldMinX = Infinity, fieldMaxX = -Infinity;
  Object.values(rowMap).forEach(rb => {
    fieldMinX = Math.min(fieldMinX, rb.minX);
    fieldMaxX = Math.max(fieldMaxX, rb.maxX);
  });
  if (fieldMinX === Infinity) { fieldMinX = 0; fieldMaxX = 0; }

  const MARGIN      = 60;
  const MARGIN_BACK = 120;

  const info = connections.map(({ fromId, toId }) => {
    const fromEl = canvas.querySelector(`.prompt-wrapper[data-id="${fromId}"]`);
    const toEl   = canvas.querySelector(`.prompt-wrapper[data-id="${toId}"]`);
    if (!fromEl || !toEl) return null;
    const isSelf  = fromId === toId;
    const fRect   = blockRect(fromEl);
    const tRect   = isSelf ? fRect : blockRect(toEl);
    const fRow    = prompts.find(p => p.id === fromId)?.row ?? 0;
    const tRow    = prompts.find(p => p.id === toId)?.row ?? 0;
    const dy = tRect.cy - fRect.cy;
    const dx = tRect.cx - fRect.cx;
    const rowDiff = tRow - fRow;

    if (rowDiff === 0 && !isSelf) return null; // same-row: no horizontal connections

    let type, fromSide, toSide;
    if (isSelf) {
      type='self'; fromSide='top'; toSide='top';

    } else if (rowDiff === 1) {
      type='down1'; fromSide='bottom'; toSide='top';

    } else if (rowDiff > 1) {
      type='downN'; fromSide='bottom'; toSide='top';

    } else {
      // Back-edge: exit bottom, arc above all rows, enter top
      type='up'; fromSide='bottom'; toSide='top';
    }
    return { fromEl, toEl, fRect, tRect, fRow, tRow, isSelf, type, fromSide, toSide, dx };
  });

  connections.forEach(({ fromId, toId }, index) => {
    const m = info[index];
    if (!m) return;
    const { fRect, tRect, fRow, tRow, isSelf, type, fromSide, toSide, dx } = m;
    const fp = dotPt(fRect, fromSide);
    const tp = isSelf ? {...fp} : dotPt(tRect, toSide);

    let d, lastSeg, midSeg;

    if (isSelf) {
      const W = 58, H = 50;
      lastSeg = { x: fp.x - W*2, y: fp.y };
      // middle = midpoint of top horizontal segment
      midSeg  = { x: (fp.x + lastSeg.x) / 2, y: fp.y - H };
      d = `M ${fp.x} ${fp.y} L ${fp.x} ${fp.y-H} L ${lastSeg.x} ${fp.y-H} L ${lastSeg.x} ${fp.y} L ${fp.x} ${fp.y}`;

    } else if (type === 'down1') {
      const midY = fp.y + (tp.y - fp.y) / 2;
      lastSeg = { x: tp.x, y: midY };
      // middle = midpoint of horizontal elbow segment
      midSeg  = { x: (fp.x + tp.x) / 2, y: midY };
      d = `M ${fp.x} ${fp.y} L ${fp.x} ${midY} L ${tp.x} ${midY} L ${tp.x} ${tp.y}`;

    } else if (type === 'downN') {
      const goRight = dx >= 0;
      let outerEdge = goRight ? -Infinity : Infinity;
      for (let r = fRow; r <= tRow; r++) {
        const rb = rowMap[r];
        if (!rb) continue;
        outerEdge = goRight ? Math.max(outerEdge, rb.maxX) : Math.min(outerEdge, rb.minX);
      }
      if (outerEdge === -Infinity) outerEdge = fieldMaxX;
      if (outerEdge ===  Infinity) outerEdge = fieldMinX;
      const arcX   = goRight ? outerEdge + MARGIN_BACK : outerEdge - MARGIN_BACK;
      const exitY  = fp.y + GAP_Y * 0.7;
      const entryY = tp.y - GAP_Y * 0.7;
      lastSeg = { x: tp.x, y: entryY };
      // middle = midpoint of the vertical side run
      midSeg  = { x: arcX, y: (exitY + entryY) / 2 };
      d = `M ${fp.x} ${fp.y} L ${fp.x} ${exitY} L ${arcX} ${exitY} L ${arcX} ${entryY} L ${tp.x} ${entryY} L ${tp.x} ${tp.y}`;

    } else {
      // Back-edge: exit bottom, arc just above target row, enter target top dot.
      // arcY sits halfway into the gap above the target row — no need to go
      // all the way to the canvas top; just clear the target row's header.
      const arcY  = tRect.y - GAP_Y * 0.5;
      const exitY = fp.y + GAP_Y * 0.5;

      // Widest row bounds across all rows between source and target (inclusive)
      const minRow = Math.min(fRow, tRow);
      const maxRow = Math.max(fRow, tRow);
      let spannedMinX = Infinity, spannedMaxX = -Infinity;
      for (let r = minRow; r <= maxRow; r++) {
        const rb = rowMap[r];
        if (!rb) continue;
        spannedMinX = Math.min(spannedMinX, rb.minX);
        spannedMaxX = Math.max(spannedMaxX, rb.maxX);
      }
      if (spannedMinX === Infinity)  spannedMinX = fieldMinX;
      if (spannedMaxX === -Infinity) spannedMaxX = fieldMaxX;

      // Inner edges of just source and target blocks
      const innerLeft  = Math.min(fRect.x, tRect.x);
      const innerRight = Math.max(fRect.x + fRect.w, tRect.x + tRect.w);

      // Clear space on each side between the two blocks and the spanned row boundary
      const leftClear  = innerLeft  - spannedMinX;
      const rightClear = spannedMaxX - innerRight;

      // Go toward the side with MORE clear space
      const goRight = leftClear >= rightClear;
      const sideX   = goRight
        ? spannedMaxX + MARGIN_BACK
        : spannedMinX - MARGIN_BACK;

      lastSeg = { x: tp.x, y: arcY };
      midSeg  = { x: (sideX + tp.x) / 2, y: arcY };
      d = `M ${fp.x} ${fp.y} L ${fp.x} ${exitY} L ${sideX} ${exitY} L ${sideX} ${arcY} L ${tp.x} ${arcY} L ${tp.x} ${tp.y}`;
    }

    if (!isSelf) d = roundPath(d, 6);
    const g = svgEl('g');
    g.classList.add('conn-group');
    g.style.cssText = 'cursor:pointer;pointer-events:none;';
    const vis = makePath({
      fill:'none', stroke:'#000000', 'stroke-width':'1.5',
      'stroke-linecap':'round','stroke-linejoin':'round',
      'marker-end':'url(#arrowhead)', d });
    const hit = makePath({fill:'none',stroke:'transparent','stroke-width':'12',d});
    hit.style.pointerEvents='stroke'; hit.style.cursor='pointer';
    vis.style.pointerEvents='none';
    g.appendChild(hit); g.appendChild(vis);

    const setHover=(on)=>{
      vis.setAttribute('stroke',on?'#FF1D33':'#000000');
      vis.setAttribute('stroke-width',on?'2':'1.5');
      vis.setAttribute('marker-end',on?'url(#arrowhead-hover)':'url(#arrowhead)');
    };
    hit.addEventListener('mouseenter',()=>setHover(true));
    hit.addEventListener('mouseleave',(e)=>{
      const lbl=canvas.querySelector(`.conn-label-node[data-conn-index="${index}"]`);
      if(lbl&&lbl.contains(e.relatedTarget))return;
      setHover(false);
    });
    hit.addEventListener('click',(e)=>{
      e.stopPropagation(); connections.splice(index,1); renderConnections();
    });
    svg.appendChild(g);

    {
      const conn=connections[index];
      const node=document.createElement('div');
      node.className='conn-label-node prompt-title';
      node.dataset.connIndex=index;
      const h6=document.createElement('h6');
      h6.className='prompt-title-text conn-label-text';
      h6.textContent=conn.label||'Untitled Connection';
      node.appendChild(h6); canvas.appendChild(node);
      node.style.left = midSeg.x + 'px';
      node.style.top  = midSeg.y + 'px';
      const MAX=48,NAV=['Backspace','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Tab'];
      const clamp=()=>{if(h6.innerText.length>MAX){h6.innerText=h6.innerText.slice(0,MAX);cursorToEnd(h6);}};
      const startEdit=()=>{h6.contentEditable='true';node.classList.add('editing');h6.focus();cursorToEnd(h6);};
      const finishEdit=()=>{
        h6.contentEditable='false';node.classList.remove('editing');
        conn.label=h6.innerText.replace(/\u200B/g,'').trim()||'Untitled Connection';
        h6.textContent=conn.label;
      };
      node.addEventListener('mouseenter',()=>setHover(true));
      node.addEventListener('mouseleave',(e)=>{if(e.relatedTarget!==hit&&!hit.contains(e.relatedTarget))setHover(false);});
      h6.addEventListener('dblclick',(e)=>{e.stopPropagation();startEdit();});
      h6.addEventListener('blur',()=>{clamp();finishEdit();});
      h6.addEventListener('input',clamp);
      h6.addEventListener('keydown',(e)=>{
        if(e.key==='Enter'){e.preventDefault();clamp();finishEdit();return;}
        if(h6.innerText.length>=MAX&&!NAV.includes(e.key)&&!e.ctrlKey&&!e.metaKey)e.preventDefault();
      });
      h6.addEventListener('paste',(e)=>{
        e.preventDefault();
        const p=(e.clipboardData||window.clipboardData).getData('text/plain')||'';
        document.execCommand('insertText',false,p.slice(0,Math.max(0,MAX-h6.innerText.length)));
      });
    }

    if(connections[index].isNew){
      connections[index].isNew=false;
      vis.removeAttribute('marker-end');
      requestAnimationFrame(()=>{
        const len=vis.getTotalLength();
        vis.style.strokeDasharray=vis.style.strokeDashoffset=len;
        vis.style.transition='none';
        requestAnimationFrame(()=>{
          vis.style.transition='stroke-dashoffset 0.5s cubic-bezier(0.22,1,0.36,1)';
          vis.style.strokeDashoffset=0;
          vis.addEventListener('transitionend',()=>{
            vis.setAttribute('marker-end','url(#arrowhead)');
            vis.style.strokeDasharray=vis.style.strokeDashoffset=vis.style.transition='';
          },{once:true});
        });
      });
    }
  });

  requestAnimationFrame(()=>expandSpacerForLabels());
}

function drawPreview(x1, y1, x2, y2) {
  const svg = getSvg();
  if (!svg) return;
  ensureMarkers(svg);
  let p = svg.querySelector("#preview-path");
  if (!p) {
    p = makePath({
      id: "preview-path", fill: "none", stroke: "#cccccc",
      "stroke-width": "1.5", "stroke-dasharray": "6 4",
      "marker-end": "url(#arrowhead-preview)",
    });
    svg.appendChild(p);
  }
  const midY = y1 + (y2 - y1) / 2;
  const d = roundPath(`M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`, 6);
  p.setAttribute("d", d);
}

function initDragConnect(wrapper, id) {
  const SIDE_MAP = {'edge-dot--top':'top','edge-dot--bottom':'bottom'};
  wrapper.querySelectorAll('.edge-dot').forEach(dot => {
    const side = Object.keys(SIDE_MAP).find(cls => dot.classList.contains(cls));
    if (!side) return;
    dot.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const pt = dotPt(blockRect(wrapper), SIDE_MAP[side]);
      drag = { fromId: id, x1: pt.x, y1: pt.y };
      document.body.style.cursor = 'crosshair';
    });
  });
}

document.addEventListener("dragover", (e) => {
  if (window.__dragClone) {
    window.__dragClone.style.left = (e.clientX + 12) + "px";
    window.__dragClone.style.top  = (e.clientY + 12) + "px";
  }
});

document.addEventListener("mousemove", (e) => {
  if (!drag) return;
  const pos = clientToCanvas(e.clientX, e.clientY);
  drawPreview(drag.x1, drag.y1, pos.x, pos.y);
});

document.addEventListener("mouseup", (e) => {
  if (!drag) return;
  const target = e.target.closest(".prompt-wrapper[data-id]");
  if (target && target.dataset.id !== drag.fromId) {
    const toId = target.dataset.id;
    if (!connections.some(c => c.fromId === drag.fromId && c.toId === toId)) {
      const conn = { fromId: drag.fromId, toId, label: "Untitled Connection", isNew: true };
      connections.push(conn);
      renderConnections();
      requestAnimationFrame(() => {
        const idx = connections.indexOf(conn);
        if (idx !== -1) startConnLabelEdit(idx);
      });
    }
  }
  getSvg()?.querySelector("#preview-path")?.remove();
  drag = null;
  document.body.style.cursor = "";
});

// ─── Connection label editing ─────────────────────────────────────────────────
function startConnLabelEdit(connIndex) {
  const node = getCanvas()?.querySelector(`.conn-label-node[data-conn-index="${connIndex}"]`);
  const h6   = node?.querySelector(".conn-label-text");
  if (!node || !h6) return;
  h6.contentEditable = "true";
  node.classList.add("editing");
  h6.focus();
  cursorToEnd(h6);
}

// ─── Zoom ─────────────────────────────────────────────────────────────────────
function applyZoom(anchorCX, anchorCY, anchorVX, anchorVY) {
  const canvas = getCanvas();
  if (!canvas) return;
  canvas.style.transform       = `scale(${zoomLevel})`;
  canvas.style.transformOrigin = "top left";
  el("zoom-label").textContent = Math.round(zoomLevel * 100) + "%";
  updateSpacerSize();
  if (anchorCX !== undefined) {
    const main       = getMain();
    const leftOffset = parseInt(canvas.style.left) || 0;
    main.scrollLeft  = anchorCX * zoomLevel + leftOffset - anchorVX;
    main.scrollTop   = anchorCY * zoomLevel - anchorVY;
  }
  renderConnections();
}

function viewportCenter() {
  const main       = getMain();
  const canvas     = getCanvas();
  const leftOffset = parseInt(canvas?.style.left) || 0;
  const vx = main.clientWidth  / 2;
  const vy = main.clientHeight / 2;
  return {
    cx: (main.scrollLeft + vx - leftOffset) / zoomLevel,
    cy: (main.scrollTop  + vy) / zoomLevel,
    vx,
    vy,
  };
}

function zoom(dir) {
  const { cx, cy, vx, vy } = viewportCenter();
  const next = dir > 0
    ? ZOOM_STEPS.find(s => s > zoomLevel + 0.001)
    : [...ZOOM_STEPS].reverse().find(s => s < zoomLevel - 0.001);
  if (next === undefined) return;
  zoomLevel = next;
  applyZoom(cx, cy, vx, vy);
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
let BLOCK_DATA = null;

async function loadBlockData() {
  const res  = await fetch("prompt_blocks.json");
  BLOCK_DATA = await res.json();
}

function renderSidebarPhrases(key) {
  const cat = BLOCK_DATA?.[key];
  if (!cat) return;
  const square = el("sidebar-square");
  square.style.background = cat.color;
  square.innerHTML = cat.icon ?? "";
  el("sidebar-title").textContent        = cat.title;
  el("sidebar-description").textContent  = cat.description;

  const container = el("sidebar-phrases");
  container.innerHTML = "";

  cat.phrases.forEach((phrase, i) => {
    const chip = document.createElement("div");
    chip.className = "phrase-chip";
    chip.style.setProperty("--chip-color", cat.color);
    chip.style.opacity = "0";

    const h3 = document.createElement("h3");
    h3.textContent = phrase;
    chip.appendChild(h3);

    chip.draggable = true;
    chip.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "copy";
      e.dataTransfer.setData("text/plain", phrase);
      e.dataTransfer.setData("application/x-docublock-color",  cat.color);
      e.dataTransfer.setData("application/x-docublock-phrase", phrase);
      window.__dragColor = cat.color;

      const ghost = document.createElement("canvas");
      ghost.width = ghost.height = 1;
      e.dataTransfer.setDragImage(ghost, 0, 0);

      const clone = document.createElement("div");
      clone.className = "phrase-chip chip-drag-clone";
      clone.style.setProperty("--chip-color", cat.color);
      clone.style.width = chip.offsetWidth + "px";
      const cloneH3 = document.createElement("h3");
      cloneH3.textContent = phrase;
      clone.appendChild(cloneH3);
      document.body.appendChild(clone);
      window.__dragClone = clone;

      clone.style.left = (e.clientX + 12) + "px";
      clone.style.top  = (e.clientY + 12) + "px";
    });

    chip.addEventListener("dragend", () => {
      window.__dragClone?.remove();
      window.__dragClone = null;
      window.__dragColor = null;
    });
    container.appendChild(chip);

    setTimeout(() => {
      chip.style.opacity = "";
      chip.classList.add("chip-enter");
      chip.addEventListener("animationend", () => chip.classList.remove("chip-enter"), { once: true });
    }, i * 40);
  });
}


// ─── Export / Import ──────────────────────────────────────────────────────────
function extractPlainText(textEl) {
  // Recursively walk nodes, preserving block-phrase encoding and newlines
  function walk(node) {
    let out = "";
    node.childNodes.forEach(child => {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.textContent.replace(/\[\//g, "\\[/");
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        if (child.classList.contains("block-phrase")) {
          const color = child.style.getPropertyValue("--phrase-color").trim() || "#cccccc";
          const text  = child.textContent.replace(/\u200B/g, "").replace(/\]§/g, "\\]§");
          out += `§[${color}|${text}]§`;
        } else if (tag === "br") {
          out += "\n";
        } else if (tag === "div" || tag === "p") {
          out += "\n" + walk(child);
        } else {
          out += walk(child);
        }
      }
    });
    return out;
  }
  return walk(textEl).replace(/\u200B/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

function snapshotPrompts() {
  const canvas = getCanvas();
  const snap = {};
  if (!canvas) return snap;
  canvas.querySelectorAll(".prompt-wrapper[data-id]").forEach(w => {
    const p = prompts.find(p => p.id === w.dataset.id);
    snap[w.dataset.id] = {
      id:    w.dataset.id,
      title: (w.querySelector(".prompt-title-text")?.innerText || "UnnamedAgent")
               .replace(/\u200B/g, "").trim().replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_]/g, ""),
      label: (w.querySelector(".prompt-title-text")?.innerText || "Unnamed Agent")
               .replace(/\u200B/g, "").trim(),
      text:  extractPlainText(w.querySelector(".prompt-text")),
      row:   p?.row ?? 0,
      slot:  p?.slot ?? 0,
    };
  });
  return snap;
}

function buildTextExport(snap, orderedIds) {
  const lines = [];
  const projectTitle = document.getElementById("project-title")?.innerText.trim() || "Untitled Project";
  lines.push("DOCUBLOCK PIPELINE EXPORT");
  lines.push(`Project: ${projectTitle}`);
  lines.push(`Generated: ${new Date().toLocaleString()}`);
  lines.push("");

  orderedIds.forEach(id => {
    const p = snap[id];
    lines.push("[BLOCK]");
    lines.push(`id: ${p.id}`);
    lines.push(`title: ${p.label}`);
    lines.push(`row: ${p.row}`);
    lines.push(`slot: ${p.slot}`);
    lines.push("---");
    lines.push(p.text || "");
    lines.push("[/BLOCK]");
    lines.push("");
  });

  if (connections.length) {
    lines.push("[CONNECTIONS]");
    connections.forEach(c => {
      const from = snap[c.fromId];
      const to   = snap[c.toId];
      if (from && to) lines.push(`${c.fromId} -> ${c.toId} :: ${c.label || 'Untitled Connection'}`);
    });
    lines.push("[/CONNECTIONS]");
    lines.push("");
  }

  return lines.join("\n");
}

function exportPrompts() {
  const snap    = snapshotPrompts();
  const ordered = Object.keys(snap).sort((a, b) => {
    return snap[a].row !== snap[b].row
      ? snap[a].row - snap[b].row
      : snap[a].slot - snap[b].slot;
  });
  if (!ordered.length) return;

  const text = buildTextExport(snap, ordered);
  const projectTitle = document.getElementById("project-title")?.innerText.trim() || "Untitled Project";
  const safeTitle    = projectTitle.replace(/[^a-z0-9_\-\s]/gi, "").trim().replace(/\s+/g, "_") || "untitled_project";
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `${safeTitle}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  showExportToast();
}

const CHECK_SVG = `<svg class="btn-check-icon" width="11" height="11" viewBox="0 0 12 12" fill="none">
  <polyline class="check-path" points="1.5,6 4.5,9.5 10.5,2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`;

function showExportToast() {
  flashButtonSuccess(el("export-btn"));
}

function flashButtonSuccess(btn) {
  if (!btn || btn._successActive) return;
  btn._successActive = true;

  // Save original inner HTML
  const originalHTML = btn.innerHTML;

  // Swap to checkmark
  btn.innerHTML = CHECK_SVG + `<span class="export-label">${btn.id === "export-btn" ? "Exported!" : "Imported!"}</span>`;
  btn.classList.add("btn-success");

  const resetTimer = setTimeout(() => {
    btn.classList.add("btn-success-exit");
    btn.addEventListener("transitionend", () => {
      btn.innerHTML = originalHTML;
      btn.classList.remove("btn-success", "btn-success-exit");
      btn._successActive = false;
    }, { once: true });
  }, 2200);

  btn._successTimer = resetTimer;
}

function parseTextImport(text) {
  const blocks = [];
  const importedConnections = [];

  const projectMatch = text.match(/^Project:\s*(.+)$/m);
  const projectTitle = projectMatch ? projectMatch[1].trim() : null;

  const blockRe = /\[BLOCK\]([\s\S]*?)\[\/BLOCK\]/g;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    const chunk = m[1];
    const idMatch    = chunk.match(/^id:\s*(.+)$/m);
    const titleMatch = chunk.match(/^title:\s*(.+)$/m);
    const rowMatch   = chunk.match(/^row:\s*(\d+)$/m);
    const slotMatch  = chunk.match(/^slot:\s*(\d+)$/m);
    const sepIdx     = chunk.indexOf("\n---\n");

    if (!idMatch || !titleMatch || !rowMatch || !slotMatch) continue;

    const bodyRaw = sepIdx !== -1 ? chunk.slice(sepIdx + 5) : "";
    blocks.push({
      id:    idMatch[1].trim(),
      title: titleMatch[1].trim(),
      row:   parseInt(rowMatch[1], 10),
      slot:  parseInt(slotMatch[1], 10),
      text:  bodyRaw.trim(),
    });
  }

  if (!blocks.length) return null;

  const connSection = text.match(/\[CONNECTIONS\]([\s\S]*?)\[\/CONNECTIONS\]/);
  if (connSection) {
    const connLines = connSection[1].trim().split("\n");
    connLines.forEach(line => {
      const parts = line.match(/^(\S+)\s*->\s*(\S+)(?:\s*::\s*(.+))?$/);
      if (parts) importedConnections.push({ fromId: parts[1], toId: parts[2], label: (parts[3] || 'Untitled Connection').trim() });
    });
  }

  return { blocks, connections: importedConnections, projectTitle };
}

function applyImport(parsed) {
  prompts.length = 0;
  connections.length = 0;
  measuredRowH = {};

  if (parsed.projectTitle) {
    const projEl = document.getElementById("project-title");
    if (projEl) projEl.innerText = parsed.projectTitle;
  }

  parsed.blocks.forEach(b => {
    prompts.push({ id: b.id, row: b.row, slot: b.slot });
  });

  parsed.connections.forEach(c => {
    connections.push({ fromId: c.fromId, toId: c.toId, label: c.label || 'Untitled Connection', isNew: false });
  });

  render();

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      parsed.blocks.forEach(b => {
        const wrapper = document.querySelector(`.prompt-wrapper[data-id="${b.id}"]`);
        if (!wrapper) return;

        const titleEl = wrapper.querySelector(".prompt-title-text");
        if (titleEl) titleEl.innerText = b.title || "Untitled Prompt";

        const textEl = wrapper.querySelector(".prompt-text");
        if (textEl && b.text) {
          textEl.innerHTML = "";
          const parts = b.text.split(/(§\[.*?\]§)/s);
          parts.forEach(part => {
            const m = part.match(/^§\[([^|]+)\|(.+)\]§$/s);
            if (m) {
              const span = document.createElement("span");
              span.className = "block-phrase";
              span.style.setProperty("--phrase-color", m[1]);
              span.textContent = m[2].replace(/\\\]§/g, "]§"); // unescape
              textEl.appendChild(span);
            } else if (part) {
              // Split on newlines — text nodes don't render \n, need <br> elements
              const lines = part.split("\n");
              lines.forEach((line, i) => {
                if (line) textEl.appendChild(document.createTextNode(line.replace(/\\\[\//g, "[/")));
                if (i < lines.length - 1) textEl.appendChild(document.createElement("br"));
              });
            }
          });
          // Restore padSpans so all 4 cursor positions work after import
          textEl.querySelectorAll(".block-phrase").forEach(span => {
            // Before: needs ​
            const prev = span.previousSibling;
            if (!prev || prev.nodeType !== Node.TEXT_NODE)
              span.parentNode.insertBefore(document.createTextNode("\u200B"), span);
            else if (prev.nodeValue.replace(/\u200B/g,"") === "" && prev.nodeValue.length < 2)
              prev.nodeValue = "\u200B\u200B"; // 2x between adjacent spans
            // After: needs ​
            const next = span.nextSibling;
            if (!next || next.nodeType !== Node.TEXT_NODE)
              span.parentNode.insertBefore(document.createTextNode("\u200B"), span.nextSibling || null);
            else if (next.nodeValue.replace(/\u200B/g,"") === "" && next.nodeValue.length < 2)
              next.nodeValue = "\u200B\u200B";
            // Inside: leading ​ for [↓chip] position
            const first = span.firstChild;
            if (first && first.nodeType === Node.TEXT_NODE && !first.nodeValue.startsWith("\u200B"))
              first.nodeValue = "\u200B" + first.nodeValue;
          });
          textEl.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });

      renderConnections();
    });
  });
}

function triggerImportFile() {
  el("import-file-input").value = "";
  el("import-file-input").click();
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  await loadBlockData();
  render();

  el("zoom-in").addEventListener("click",  () => zoom(+1));
  el("zoom-out").addEventListener("click", () => zoom(-1));
  el("export-btn").addEventListener("click", exportPrompts);
  el("import-btn").addEventListener("click", triggerImportFile);

  // ── Project title inline editing ──────────────────────────────────────────
  const projTitle = el("project-title");
  const projWrap  = el("project-title-wrap");
  const MAX_PROJ  = 40;

  const startProjEdit = () => {
    projTitle.contentEditable = "true";
    projWrap.classList.add("editing");
    projTitle.focus();
    cursorToEnd(projTitle);
  };
  const finishProjEdit = () => {
    projTitle.contentEditable = "false";
    projWrap.classList.remove("editing");
    if (!projTitle.innerText.trim()) projTitle.innerText = "Untitled Project";
  };
  const clampProj = () => {
    if (projTitle.innerText.length > MAX_PROJ) {
      projTitle.innerText = projTitle.innerText.slice(0, MAX_PROJ);
      cursorToEnd(projTitle);
    }
  };

  const NAV_KEYS_PROJ = ["Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Tab"];

  projTitle.addEventListener("dblclick", startProjEdit);
  projTitle.addEventListener("blur",  () => { clampProj(); finishProjEdit(); });
  projTitle.addEventListener("input", clampProj);
  projTitle.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); clampProj(); finishProjEdit(); return; }
    if (projTitle.innerText.length >= MAX_PROJ && !NAV_KEYS_PROJ.includes(e.key) && !e.ctrlKey && !e.metaKey)
      e.preventDefault();
  });
  // ─────────────────────────────────────────────────────────────────────────

  el("import-file-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result;
      const parsed = parseTextImport(text);
      if (!parsed || !parsed.blocks.length) {
        alert("Could not read this file. Make sure it is a DocuBlock export.");
        return;
      }
      applyImport(parsed);
      flashButtonSuccess(el("import-btn"));
    };
    reader.readAsText(file);
  });

  const list = el("sidebar-dropdown-list");
  Object.keys(BLOCK_DATA).forEach(key => {
    const li = document.createElement("li");
    li.textContent = BLOCK_DATA[key].title;
    li.dataset.key = key;
    list.appendChild(li);
  });

  const firstKey = Object.keys(BLOCK_DATA)[0];
  renderSidebarPhrases(firstKey);
  list.querySelector(`[data-key="${firstKey}"]`)?.setAttribute("aria-selected", "true");

  const closeDropdown = () => {
    el("sidebar-dropdown-wrap").classList.remove("is-open");
    list.classList.remove("is-open");
  };

  const ICON_OPEN  = `<polyline points="3,2 7,5 3,8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  const ICON_CLOSE = `<polyline points="7,2 3,5 7,8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;

  el("sidebar-toggle").addEventListener("click", () => {
    const sidebar = el("sidebar");
    const isOpen  = sidebar.classList.contains("is-open");

    if (isOpen) {
      // Closing: fade content first, then collapse
      sidebar.classList.add("is-closing");
      closeDropdown();
      setTimeout(() => {
        sidebar.classList.remove("is-open");
        sidebar.classList.remove("is-closing");
        el("sidebar-arrow").innerHTML = ICON_OPEN;
        requestAnimationFrame(() => updateSpacerSize(true));
      }, 150);
    } else {
      // Opening: just add is-open, CSS handles the delayed fade-in
      sidebar.classList.add("is-open");
      el("sidebar-arrow").innerHTML = ICON_CLOSE;
      closeDropdown();
      requestAnimationFrame(() => updateSpacerSize(true));
    }
  });

  el("sidebar-dropdown-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = !list.classList.contains("is-open");
    el("sidebar-dropdown-wrap").classList.toggle("is-open", opening);
    list.classList.toggle("is-open", opening);
  });

  list.addEventListener("click", (e) => {
    const item = e.target.closest("li[data-key]");
    if (!item) return;
    e.stopPropagation();
    list.querySelectorAll("li").forEach(li => li.removeAttribute("aria-selected"));
    item.setAttribute("aria-selected", "true");
    renderSidebarPhrases(item.dataset.key);
    closeDropdown();
  });

  document.addEventListener("click", closeDropdown);
});