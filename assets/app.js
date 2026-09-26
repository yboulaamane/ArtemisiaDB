/*
 * ArtemisiaDB compound browser.
 *
 * Loads artemisia.json (the single source of truth for the table) and renders
 * a searchable, filterable, sortable table with 2D structures drawn in the
 * browser by SmilesDrawer. No build step: edit artemisia.json and reload.
 */
(function () {
  "use strict";

  const DATA_URL = "artemisia.json";
  const SVG_NS = "http://www.w3.org/2000/svg";

  // Every field in coumarins.json, in file order. Used for details and exports.
  const FIELDS = [
    { key: "name", label: "Name" },
    { key: "identifier", label: "Identifier" },
    { key: "adb_id", label: "ADB ID" },
    { key: "smiles", label: "SMILES" },
    { key: "natural_source", label: "Plant" },
    { key: "total_molweight", label: "Molecular weight", unit: "g/mol", num: true },
    { key: "clogp", label: "cLogP", num: true },
    { key: "clogs", label: "cLogS", num: true },
    { key: "h_acceptors", label: "H-bond acceptors", num: true },
    { key: "h_donors", label: "H-bond donors", num: true },
    { key: "polar_surface_area", label: "Polar surface area", unit: "Å²", num: true },
    { key: "molecular_formula", label: "Molecular formula" },
    { key: "inchi_key", label: "InChIKey" },
    { key: "references", label: "References" },
  ];
  const NUM_KEYS = FIELDS.filter((f) => f.num).map((f) => f.key);

  // Table columns. SMILES, InChIKey and PubChem CID are in the details view.
  const COLUMNS = [
    { key: "structure", label: "Structure", sortable: false },
    { key: "adb_id", label: "ID" },
    { key: "name", label: "Name" },
    { key: "molecular_formula", label: "Formula" },
    { key: "natural_source", label: "Plant" },
    { key: "total_molweight", label: "MW", title: "Molecular weight (g/mol)", num: true },
    { key: "clogp", label: "cLogP", title: "Calculated logP", num: true },
    { key: "clogs", label: "cLogS", title: "Calculated log solubility", num: true },
    { key: "polar_surface_area", label: "TPSA", title: "Polar surface area (Å²)", num: true },
    { key: "h_acceptors", label: "HBA", title: "Hydrogen-bond acceptors", num: true },
    { key: "h_donors", label: "HBD", title: "Hydrogen-bond donors", num: true },
  ];
  const COLUMN_BY_KEY = new Map(COLUMNS.map((c) => [c.key, c]));

  // Min/max filters shown under "More filters". `id` is also the URL parameter prefix.
  const RANGES = [
    { id: "mw", key: "total_molweight", label: "Molecular weight (g/mol)" },
    { id: "logp", key: "clogp", label: "cLogP" },
    { id: "tpsa", key: "polar_surface_area", label: "TPSA (Å²)" },
  ];

  const PAGE_SIZES = [25, 50, 100];
  const DEFAULT_SORT = { key: "adb_id", dir: 1 };

  const state = {
    q: "",
    cls: "",
    range: Object.fromEntries(RANGES.map((r) => [r.id, [null, null]])),
    ro5: false,
    sort: { ...DEFAULT_SORT },
    page: 1,
    size: PAGE_SIZES[0],
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    status: $("status"),
    browser: $("browser-body"),
    stats: $("stats"),
    search: $("search"),
    cls: $("class-filter"),
    ranges: $("range-filters"),
    ro5: $("filter-ro5"),
    reset: $("reset-filters"),
    filterCount: $("filter-count"),
    count: $("result-count"),
    exportCsv: $("export-csv"),
    exportSmi: $("export-smi"),
    thead: $("table-head"),
    tbody: $("table-body"),
    empty: $("empty-state"),
    prev: $("page-prev"),
    next: $("page-next"),
    pageInfo: $("page-info"),
    size: $("page-size"),
    dialog: $("detail"),
  };

  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  let records = [];
  let byId = new Map();
  let filtered = [];

  /* ---------- Data ---------- */

  function prepare(raw) {
    return raw.map((r, i) => {
      const n = {};
      for (const k of NUM_KEYS) {
        const v = parseFloat(r[k]);
        n[k] = Number.isFinite(v) ? v : null;
      }
      const ro5 =
        (n.total_molweight > 500) + (n.clogp > 5) + (n.h_donors > 5) + (n.h_acceptors > 10);
      const text = [
        r.adb_id, r.name, r.identifier, r.molecular_formula, r.smiles,
        r.inchi_key, r.natural_source, r.references,
      ].join("\u0001").toLowerCase();
      return Object.assign({}, r, { _i: i, _n: n, _ro5: ro5, _text: text });
    });
  }

  function applyFilters() {
    const terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    return records.filter((r) => {
      if (state.cls && r.natural_source !== state.cls) return false;
      for (const t of terms) if (!r._text.includes(t)) return false;
      for (const rg of RANGES) {
        const [lo, hi] = state.range[rg.id];
        const v = r._n[rg.key];
        if (lo !== null && !(v >= lo)) return false;
        if (hi !== null && !(v <= hi)) return false;
      }
      if (state.ro5 && r._ro5 > 1) return false;
      return true;
    });
  }

  function sortRows(rows) {
    const { key, dir } = state.sort;
    const col = COLUMN_BY_KEY.get(key);
    const cmp = col && col.num
      ? (a, b) => {
          const x = a._n[key];
          const y = b._n[key];
          if (x === null || y === null) return (x === null) - (y === null);
          return dir * (x - y);
        }
      : (a, b) => dir * collator.compare(a[key] || "", b[key] || "");
    return rows.slice().sort((a, b) => cmp(a, b) || a._i - b._i);
  }

  function activeFilterCount() {
    let n = 0;
    for (const rg of RANGES) n += state.range[rg.id].filter((v) => v !== null).length ? 1 : 0;
    return n + state.ro5;
  }

  /* ---------- Structures ---------- */

  const structureCache = new Map();
  const drawers = {};

  function isDark() {
    return false; // ArtemisiaDB uses a light theme only
  }

  function drawer(kind) {
    if (!drawers[kind]) {
      const options = kind === "large"
        ? { width: 420, height: 320, padding: 16, bondThickness: 1.2 }
        : { width: 150, height: 110, padding: 6, bondThickness: 1.7, fontSizeLarge: 13 };
      drawers[kind] = new window.SmilesDrawer.SvgDrawer(Object.assign(options, { compactDrawing: true }));
    }
    return drawers[kind];
  }

  // Off-screen area where structures are drawn so they can be measured.
  let stage = null;
  function drawingStage() {
    if (!stage) {
      stage = document.createElement("div");
      stage.setAttribute("aria-hidden", "true");
      stage.style.cssText =
        "position:absolute;left:-10000px;top:0;width:600px;height:600px;visibility:hidden;pointer-events:none";
      document.body.appendChild(stage);
    }
    return stage;
  }

  // SmilesDrawer uses a square viewBox, which shrinks long, flat molecules.
  // Crop the viewBox to the drawing so every structure fills its box.
  function cropToDrawing(svg) {
    try {
      const bb = svg.getBBox();
      if (!(bb.width > 0 && bb.height > 0)) return;
      const pad = Math.max(bb.width, bb.height) * 0.04 + 4;
      svg.setAttribute(
        "viewBox",
        [bb.x - pad, bb.y - pad, bb.width + 2 * pad, bb.height + 2 * pad].map((v) => v.toFixed(1)).join(" ")
      );
    } catch (err) {
      // Keep SmilesDrawer's own viewBox.
    }
  }

  // Returns SVG markup for a compound, or null if it cannot be drawn.
  function structureMarkup(rec, kind) {
    if (!window.SmilesDrawer) return null;
    const theme = isDark() ? "dark" : "light";
    const cacheKey = kind + "|" + theme + "|" + rec.adb_id;
    if (structureCache.has(cacheKey)) return structureCache.get(cacheKey);
    let markup = null;
    const svg = document.createElementNS(SVG_NS, "svg");
    try {
      drawingStage().appendChild(svg);
      window.SmilesDrawer.parse(
        rec.smiles,
        (tree) => drawer(kind).draw(tree, svg, theme),
        () => {}
      );
      if (svg.childNodes.length) {
        cropToDrawing(svg);
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("focusable", "false");
        markup = svg.outerHTML;
      }
    } catch (err) {
      markup = null;
    } finally {
      svg.remove();
    }
    structureCache.set(cacheKey, markup);
    return markup;
  }

  function fillStructure(box, rec, kind) {
    const markup = structureMarkup(rec, kind);
    if (markup) {
      box.innerHTML = markup;
      box.classList.remove("no-structure");
    } else {
      box.textContent = window.SmilesDrawer ? "No depiction" : "";
      box.classList.add("no-structure");
    }
  }

  // Draw table thumbnails lazily, a few per frame, so paging stays responsive.
  let queue = [];
  let pumping = false;
  const observer = "IntersectionObserver" in window
    ? new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            observer.unobserve(e.target);
            enqueue(e.target);
          }
        }
      }, { rootMargin: "300px 0px" })
    : null;

  function enqueue(box) {
    queue.push(box);
    if (!pumping) {
      pumping = true;
      requestAnimationFrame(pump);
    }
  }

  function pump() {
    const t0 = performance.now();
    while (queue.length && performance.now() - t0 < 12) {
      const box = queue.shift();
      const rec = byId.get(box.dataset.id);
      if (box.isConnected && rec) fillStructure(box, rec, "thumb");
    }
    if (queue.length) requestAnimationFrame(pump);
    else pumping = false;
  }

  function observeThumbs() {
    if (!window.SmilesDrawer) return;
    for (const box of el.tbody.querySelectorAll(".thumb")) {
      if (observer) observer.observe(box);
      else enqueue(box);
    }
  }

  /* ---------- Rendering ---------- */

  // "C9H6O2" -> C<sub>9</sub>H<sub>6</sub>O<sub>2</sub>, built without innerHTML.
  function formulaNode(formula) {
    const frag = document.createDocumentFragment();
    for (const part of String(formula).split(/(\d+)/)) {
      if (!part) continue;
      if (/^\d+$/.test(part)) {
        const sub = document.createElement("sub");
        sub.textContent = part;
        frag.appendChild(sub);
      } else {
        frag.appendChild(document.createTextNode(part));
      }
    }
    return frag;
  }

  function buildHead() {
    const tr = document.createElement("tr");
    for (const col of COLUMNS) {
      const th = document.createElement("th");
      th.scope = "col";
      th.dataset.key = col.key;
      if (col.num) th.className = "num";
      let label = document.createTextNode(col.label);
      if (col.title) {
        label = document.createElement("abbr");
        label.title = col.title;
        label.textContent = col.label;
      }
      if (col.sortable === false) {
        th.appendChild(label);
      } else {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "sort";
        btn.dataset.key = col.key;
        btn.appendChild(label);
        const arrow = document.createElement("span");
        arrow.className = "sort-arrow";
        arrow.setAttribute("aria-hidden", "true");
        btn.appendChild(arrow);
        th.appendChild(btn);
      }
      tr.appendChild(th);
    }
    el.thead.replaceChildren(tr);
  }

  function rowNode(r) {
    const tr = document.createElement("tr");
    tr.dataset.id = r.adb_id;
    for (const col of COLUMNS) {
      const td = document.createElement("td");
      if (col.key === "structure") {
        td.className = "c-structure";
        const box = document.createElement("div");
        box.className = "thumb";
        box.dataset.id = r.adb_id;
        td.appendChild(box);
      } else if (col.key === "name") {
        td.className = "c-name";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "name-link";
        btn.dataset.id = r.adb_id;
        btn.textContent = r.name;
        td.appendChild(btn);
      } else if (col.key === "molecular_formula") {
        td.appendChild(formulaNode(r.molecular_formula));
      } else if (col.key === "chemical_class") {
        String(r.natural_source).split(" ").forEach((word, i) => {
          if (i) td.appendChild(document.createTextNode(" "));
          const span = document.createElement("span");
          span.className = "nowrap";
          span.textContent = word;
          td.appendChild(span);
        });
      } else {
        td.textContent = r[col.key];
        if (col.num) td.className = "num";
        else if (col.key === "adb_id") td.className = "c-id";
        else if (col.key === "natural_source") td.className = "c-source";
      }
      tr.appendChild(td);
    }
    return tr;
  }

  function updateSortIndicators() {
    for (const th of el.thead.querySelectorAll("th")) {
      const active = th.dataset.key === state.sort.key;
      if (COLUMN_BY_KEY.get(th.dataset.key).sortable === false) continue;
      th.setAttribute("aria-sort", active ? (state.sort.dir > 0 ? "ascending" : "descending") : "none");
    }
  }

  function render() {
    if (observer) observer.disconnect();
    queue = [];

    filtered = sortRows(applyFilters());
    const pages = Math.max(1, Math.ceil(filtered.length / state.size));
    state.page = Math.min(Math.max(1, state.page), pages);
    const start = (state.page - 1) * state.size;
    const slice = filtered.slice(start, start + state.size);

    const frag = document.createDocumentFragment();
    for (const r of slice) frag.appendChild(rowNode(r));
    el.tbody.replaceChildren(frag);
    el.empty.hidden = filtered.length > 0;

    const total = records.length;
    if (!filtered.length) {
      el.count.textContent = `No records match these filters (${total} in total).`;
    } else if (filtered.length === total) {
      el.count.textContent = `Showing ${start + 1} to ${start + slice.length} of ${total} records`;
    } else {
      el.count.textContent =
        `Showing ${start + 1} to ${start + slice.length} of ${filtered.length} matching records (${total} in total)`;
    }

    el.pageInfo.textContent = `Page ${state.page} of ${pages}`;
    el.prev.disabled = state.page <= 1;
    el.next.disabled = state.page >= pages;
    el.exportCsv.disabled = el.exportSmi.disabled = !filtered.length;
    el.exportCsv.textContent = `CSV (${filtered.length})`;
    el.exportSmi.textContent = `SMILES (${filtered.length})`;

    const nf = activeFilterCount();
    el.filterCount.textContent = nf ? ` (${nf} active)` : "";
    el.reset.hidden = !(nf || state.q || state.cls);

    updateSortIndicators();
    syncUrl();
    observeThumbs();
  }

  /* ---------- Details dialog ---------- */

  function badge(text, ok) {
    const span = document.createElement("span");
    span.className = "badge " + (ok ? "badge-pass" : "badge-fail");
    span.textContent = text;
    return span;
  }

  function copyButton(label, value) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-small";
    btn.textContent = label;
    btn.addEventListener("click", () => {
      copyText(value).then(
        () => flash(btn, "Copied"),
        () => flash(btn, "Copy failed")
      );
    });
    return btn;
  }

  function flash(btn, text) {
    const original = btn.dataset.label || btn.textContent;
    btn.dataset.label = original;
    btn.textContent = text;
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.textContent = original; }, 1500);
  }

  function copyText(value) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(value);
    return new Promise((resolve, reject) => {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      ok ? resolve() : reject(new Error("copy failed"));
    });
  }

  // "CID:123", "CHEMSPIDER:45", "CASID:50-00-0", "DOI:10.x/y", "PMID:9", "ISBN:..."
  // become links where the prefix names a resolver; anything else stays text.
  const RESOLVERS = {
    CID: (v) => `https://pubchem.ncbi.nlm.nih.gov/compound/${v}`,
    CHEMSPIDER: (v) => `https://www.chemspider.com/Chemical-Structure.${v}.html`,
    CASID: (v) => `https://commonchemistry.cas.org/detail?cas_rn=${v}`,
    DOI: (v) => `https://doi.org/${v}`,
    PMID: (v) => `https://pubmed.ncbi.nlm.nih.gov/${v}/`,
  };

  function linkList(parent, value) {
    String(value).split(/\s*,\s*/).filter(Boolean).forEach((item, i) => {
      if (i) parent.appendChild(document.createTextNode(", "));
      const m = item.match(/^([A-Za-z]+):\s*(.+)$/);
      const resolve = m && RESOLVERS[m[1].toUpperCase()];
      if (!resolve) {
        parent.appendChild(document.createTextNode(item));
        return;
      }
      const a = document.createElement("a");
      a.href = resolve(encodeURI(m[2].trim()));
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = item;
      parent.appendChild(a);
    });
  }

  function openDetail(id, { updateHash = true } = {}) {
    const r = byId.get(id);
    if (!r) return false;

    $("detail-id").textContent = r.adb_id;
    $("detail-title").textContent = r.name;
    $("detail-class").textContent = r.natural_source;

    const box = $("detail-structure");
    fillStructure(box, r, "large");
    box.setAttribute("aria-label", `2D structure of ${r.name}`);

    const badges = $("detail-badges");
    const v = r._ro5;
    badges.replaceChildren(badge(`Lipinski: ${v} violation${v === 1 ? "" : "s"}`, v <= 1));

    const dl = $("detail-props");
    dl.replaceChildren();
    const order = [
      "molecular_formula", "total_molweight", "clogp", "clogs", "polar_surface_area",
      "h_acceptors", "h_donors", "identifier", "inchi_key", "smiles", "references",
    ];
    for (const key of order) {
      const f = FIELDS.find((x) => x.key === key);
      const dt = document.createElement("dt");
      dt.textContent = f.label;
      const dd = document.createElement("dd");
      const value = r[key];
      if (!value) {
        dd.textContent = "Not recorded";
        dd.className = "muted";
      } else if (key === "molecular_formula") {
        dd.appendChild(formulaNode(value));
      } else if (key === "identifier" || key === "references") {
        linkList(dd, value);
      } else if (key === "smiles" || key === "inchi_key") {
        dd.className = "mono";
        dd.textContent = value;
      } else {
        dd.textContent = f.unit ? `${value} ${f.unit}` : value;
      }
      dl.append(dt, dd);
    }

    const actions = $("detail-actions");
    actions.replaceChildren(
      copyButton("Copy SMILES", r.smiles),
      copyButton("Copy InChIKey", r.inchi_key),
      copyButton("Copy link", location.href.split("#")[0] + "#" + r.adb_id)
    );

    if (updateHash) history.replaceState(null, "", "#" + r.adb_id);
    if (!el.dialog.open) {
      if (typeof el.dialog.showModal === "function") el.dialog.showModal();
      else el.dialog.setAttribute("open", "");
    }
    return true;
  }

  /* ---------- Exports ---------- */

  function csvCell(v) {
    const s = String(v == null ? "" : v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function download(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportCsv() {
    const keys = FIELDS.map((f) => f.key);
    const lines = [keys.join(",")];
    for (const r of filtered) lines.push(keys.map((k) => csvCell(r[k])).join(","));
    download(`artemisiadb-${filtered.length}-compounds.csv`, lines.join("\r\n") + "\r\n", "text/csv");
  }

  function exportSmiles() {
    const lines = filtered.map((r) => `${r.smiles}\t${r.adb_id}`);
    download(`artemisiadb-${filtered.length}-compounds.smi`, lines.join("\n") + "\n", "chemical/x-daylight-smiles");
  }

  /* ---------- URL state ---------- */

  function syncUrl() {
    const p = new URLSearchParams();
    if (state.q) p.set("q", state.q);
    if (state.cls) p.set("class", state.cls);
    for (const rg of RANGES) {
      const [lo, hi] = state.range[rg.id];
      if (lo !== null) p.set(rg.id + "_min", lo);
      if (hi !== null) p.set(rg.id + "_max", hi);
    }
    if (state.ro5) p.set("ro5", "1");
    if (state.sort.key !== DEFAULT_SORT.key || state.sort.dir !== DEFAULT_SORT.dir) {
      p.set("sort", state.sort.key);
      p.set("dir", state.sort.dir > 0 ? "asc" : "desc");
    }
    if (state.size !== PAGE_SIZES[0]) p.set("size", state.size);
    if (state.page > 1) p.set("page", state.page);
    const qs = p.toString();
    const url = location.pathname + (qs ? "?" + qs : "") + location.hash;
    if (url !== location.pathname + location.search + location.hash) history.replaceState(null, "", url);
  }

  function readUrl() {
    const p = new URLSearchParams(location.search);
    state.q = p.get("q") || "";
    const cls = p.get("class") || "";
    state.cls = records.some((r) => r.natural_source === cls) ? cls : "";
    for (const rg of RANGES) {
      state.range[rg.id] = [numOrNull(p.get(rg.id + "_min")), numOrNull(p.get(rg.id + "_max"))];
    }
    state.ro5 = p.get("ro5") === "1";
    const sortKey = p.get("sort");
    const col = COLUMN_BY_KEY.get(sortKey);
    if (col && col.sortable !== false) state.sort = { key: sortKey, dir: p.get("dir") === "desc" ? -1 : 1 };
    const size = parseInt(p.get("size"), 10);
    if (PAGE_SIZES.includes(size)) state.size = size;
    state.page = Math.max(1, parseInt(p.get("page"), 10) || 1);
  }

  function numOrNull(v) {
    if (v === null || String(v).trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /* ---------- Controls ---------- */

  function buildControls() {
    // Chemical class options with counts, alphabetical.
    const counts = new Map();
    for (const r of records) counts.set(r.natural_source, (counts.get(r.natural_source) || 0) + 1);
    const classes = [...counts.keys()].sort(collator.compare);
    const opts = [new Option(`All plants (${records.length})`, "")];
    for (const c of classes) opts.push(new Option(`${c} (${counts.get(c)})`, c));
    el.cls.replaceChildren(...opts);

    // Min/max inputs, with the data range as placeholders.
    const frag = document.createDocumentFragment();
    for (const rg of RANGES) {
      const values = records.map((r) => r._n[rg.key]).filter((v) => v !== null);
      const lo = Math.floor(Math.min(...values));
      const hi = Math.ceil(Math.max(...values));
      const row = document.createElement("div");
      row.className = "range-row";
      const label = document.createElement("span");
      label.className = "range-label";
      label.id = `range-${rg.id}-label`;
      label.textContent = rg.label;
      row.appendChild(label);
      for (const [i, which] of [[0, "min"], [1, "max"]]) {
        const input = document.createElement("input");
        input.type = "number";
        input.step = "any";
        input.inputMode = "decimal";
        input.id = `range-${rg.id}-${which}`;
        input.dataset.range = rg.id;
        input.dataset.index = i;
        input.placeholder = which === "min" ? `min ${lo}` : `max ${hi}`;
        input.setAttribute("aria-label", `${rg.label}, ${which === "min" ? "minimum" : "maximum"}`);
        row.appendChild(input);
      }
      frag.appendChild(row);
    }
    el.ranges.replaceChildren(frag);

    el.size.replaceChildren(...PAGE_SIZES.map((n) => new Option(String(n), String(n))));
  }

  function writeControls() {
    el.search.value = state.q;
    el.cls.value = state.cls;
    for (const input of el.ranges.querySelectorAll("input")) {
      const v = state.range[input.dataset.range][+input.dataset.index];
      input.value = v === null ? "" : v;
    }
    el.ro5.checked = state.ro5;
    el.size.value = String(state.size);
    if (activeFilterCount()) $("more-filters").open = true;
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function bindControls() {
    const update = (mutate) => {
      mutate();
      state.page = 1;
      render();
    };

    el.search.addEventListener("input", debounce(() => update(() => { state.q = el.search.value.trim(); }), 150));
    el.cls.addEventListener("change", () => update(() => { state.cls = el.cls.value; }));
    el.ranges.addEventListener("input", debounce((e) => {
      const input = e.target;
      if (!input.dataset.range) return;
      update(() => { state.range[input.dataset.range][+input.dataset.index] = numOrNull(input.value); });
    }, 250));
    el.ro5.addEventListener("change", () => update(() => { state.ro5 = el.ro5.checked; }));
    el.reset.addEventListener("click", () => {
      update(() => {
        state.q = "";
        state.cls = "";
        for (const rg of RANGES) state.range[rg.id] = [null, null];
        state.ro5 = false;
      });
      writeControls();
      el.search.focus();
    });

    el.thead.addEventListener("click", (e) => {
      const btn = e.target.closest("button.sort");
      if (!btn) return;
      const key = btn.dataset.key;
      state.sort = state.sort.key === key
        ? { key, dir: -state.sort.dir }
        : { key, dir: 1 };
      state.page = 1;
      render();
    });

    el.prev.addEventListener("click", () => { state.page -= 1; render(); scrollToTable(); });
    el.next.addEventListener("click", () => { state.page += 1; render(); scrollToTable(); });
    el.size.addEventListener("change", () => update(() => { state.size = +el.size.value; }));

    el.exportCsv.addEventListener("click", exportCsv);
    el.exportSmi.addEventListener("click", exportSmiles);

    // Open details from the name button, or from a click anywhere on the row.
    el.tbody.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      if (!e.target.closest("button.name-link") && String(window.getSelection() || "")) return;
      const tr = e.target.closest("tr[data-id]");
      if (tr) openDetail(tr.dataset.id);
    });

    el.dialog.addEventListener("close", () => {
      if (/^#ADB\d+$/i.test(location.hash)) history.replaceState(null, "", location.pathname + location.search);
    });
    // Close when the backdrop (outside the dialog box) is clicked.
    el.dialog.addEventListener("click", (e) => {
      if (e.target === el.dialog) el.dialog.close();
    });

    window.addEventListener("hashchange", () => {
      const id = location.hash.slice(1).toUpperCase();
      if (byId.has(id)) openDetail(id, { updateHash: false });
      else if (el.dialog.open) el.dialog.close();
    });

    if (window.matchMedia) {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const rerender = () => {
        render();
        if (el.dialog.open) {
          const id = $("detail-id").textContent;
          if (byId.has(id)) fillStructure($("detail-structure"), byId.get(id), "large");
        }
      };
      if (mq.addEventListener) mq.addEventListener("change", rerender);
    }
  }

  function scrollToTable() {
    const top = $("browse").getBoundingClientRect().top;
    if (top < 0) $("browse").scrollIntoView({ block: "start" });
  }

  /* ---------- Start ---------- */

  function showStats() {
    const classes = new Set(records.map((r) => r.natural_source)).size;
    el.stats.replaceChildren();
    for (const [value, label] of [[records.length, "records"], [classes, "Artemisia species"]]) {
      const div = document.createElement("div");
      div.className = "stat";
      const strong = document.createElement("strong");
      strong.textContent = value.toLocaleString("en");
      const span = document.createElement("span");
      span.textContent = label;
      div.append(strong, span);
      el.stats.appendChild(div);
    }
    el.stats.hidden = false;
  }

  async function start() {
    let raw;
    try {
      const res = await fetch(DATA_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      raw = await res.json();
    } catch (err) {
      el.status.classList.add("error");
      el.status.textContent =
        `The compound table could not be loaded (${err.message}). ` +
        "If you opened index.html straight from disk, serve the folder over HTTP instead, " +
        "for example with: python3 -m http.server. The download files above still work.";
      return;
    }

    records = prepare(raw);
    byId = new Map(records.map((r) => [r.adb_id, r]));

    buildHead();
    buildControls();
    readUrl();
    writeControls();
    bindControls();
    showStats();

    el.status.hidden = true;
    el.browser.hidden = false;
    render();

    const id = location.hash.slice(1).toUpperCase();
    if (byId.has(id)) openDetail(id, { updateHash: false });

    // SmilesDrawer loads async from a CDN. If it arrives after the first
    // render, draw the structures then. If it fails, index.html hides the
    // structure column (see the script tag's onerror).
    if (!window.SmilesDrawer) {
      const script = document.getElementById("smiles-drawer");
      if (script) script.addEventListener("load", () => render());
    }
  }

  start();
})();
