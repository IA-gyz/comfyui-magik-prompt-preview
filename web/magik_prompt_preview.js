import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "tiff"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "mkv", "webm", "avi", "m4v", "mpg", "mpeg", "wmv", "flv", "ogv", "ts"]);
const GENERIC_FONTS = {
    "Sans-serif": "sans-serif",
    "Serif": "serif",
    "Monospace": "monospace",
    "System UI": "system-ui, sans-serif",
};
const SORTS = [["manual", "Manual"], ["az", "A–Z"], ["favorites", "Favorites first"], ["newest", "Newest first"]];

const hash = (text) => {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
    return h.toString(36);
};
const kindOf = (name) => {
    if (!name || !name.includes(".")) return "none";
    const ext = name.rsplit(".", 1)[1].toLowerCase();
    return VIDEO_EXTS.has(ext) ? "video" : IMAGE_EXTS.has(ext) ? "image" : "none";
};
const splitRel = (rel) => {
    const i = rel.lastIndexOf("/");
    return i >= 0 ? { filename: rel.slice(i + 1), subfolder: rel.slice(0, i) } : { filename: rel, subfolder: "" };
};
const fileUrl = (rel) => {
    const { filename, subfolder } = splitRel(rel);
    return api.apiURL(`/view?${new URLSearchParams({ filename, subfolder, type: "input" })}`);
};
const itemUrl = (item, thumb = false) => api.apiURL(`/view?${new URLSearchParams({
    filename: thumb ? (item.thumbnail || item.filename) : item.filename,
    subfolder: item.subfolder || "", type: item.type || "temp",
})}`);

app.registerExtension({
    name: "Magik.PromptPreview",
    async beforeRegisterNodeDef(type, data) {
        if (data.name !== "MagikPromptPreview") return;
        const original = type.prototype.onNodeCreated;
        type.prototype.onNodeCreated = function () {
            original?.apply(this, arguments);
            install(this);
        };
    },
});

function install(node) {
    let disposed = false;
    let serial = 0;
    let lastMessage = null;
    let statusTimer = 0;
    node.properties ||= {};
    const state = () => node.properties.magikPromptPreview ||= {
        cards: [], order: [], favorites: [], query: "", sort: "manual",
        selected: "", compact: false, overlay: {}, mediaSide: "left",
    };
    const widget = (name) => node.widgets?.find((w) => w.name === name);
    const card = (key) => state().cards.find((c) => c.key === key);
    const fav = (key) => state().favorites.includes(key);

    const buildCards = (msg) => {
        const prompts = Array.isArray(msg?.prompts) ? msg.prompts.map(String) : [];
        const images = Array.isArray(msg?.images) ? msg.images : [];
        const file = typeof msg?.media === "string" ? msg.media : "";
        const kind = msg?.media_kind || "none";
        return prompts.map((prompt, i) => {
            const image = images[i] || null;
            return { key: `${i}|${hash(prompt)}`, prompt, image, file: image ? "" : file, kind: image ? "image" : kind };
        });
    };
    const mergeOrder = () => {
        const s = state();
        const valid = new Set(s.cards.map((c) => c.key));
        s.order = s.order.filter((k) => valid.has(k));
        for (const c of s.cards) if (!s.order.includes(c.key)) s.order.push(c.key);
        if (!valid.has(s.selected)) s.selected = s.order.at(-1) || "";
    };
    const visibleCards = () => {
        const s = state();
        let cards = s.order.map((k) => card(k)).filter(Boolean);
        const q = s.query.trim().toLowerCase();
        if (q) cards = cards.filter((c) => c.prompt.toLowerCase().includes(q));
        return cards;
    };
    const pushOrder = () => {
        const s = state();
        const indices = s.order.map((k) => s.cards.findIndex((c) => c.key === k)).filter((i) => i >= 0);
        const w = widget("sort_order");
        if (w) w.value = JSON.stringify(indices);
        node.graph?.setDirtyCanvas(true, true);
    };
    const applySort = () => {
        const s = state();
        if (s.sort === "az") s.order = [...s.order].sort((a, b) => (card(a)?.prompt || "").localeCompare(card(b)?.prompt || ""));
        else if (s.sort === "favorites") s.order = [...s.order].sort((a, b) => (fav(b) ? 1 : 0) - (fav(a) ? 1 : 0));
        else if (s.sort === "newest") s.order = [...s.order].reverse();
        mergeOrder();
        pushOrder();
    };
    const move = (delta) => {
        const s = state();
        const i = s.order.indexOf(s.selected);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= s.order.length) return;
        const [k] = s.order.splice(i, 1);
        s.order.splice(j, 0, k);
        pushOrder();
        render();
    };
    const navigate = (delta) => {
        const all = visibleCards();
        if (!all.length) return;
        const i = all.findIndex((c) => c.key === state().selected);
        state().selected = all[(i + delta + all.length) % all.length].key;
        render();
    };
    const toggleFav = () => {
        const s = state();
        if (!s.selected) return;
        const i = s.favorites.indexOf(s.selected);
        if (i >= 0) s.favorites.splice(i, 1); else s.favorites.push(s.selected);
        node.graph?.setDirtyCanvas(true, true);
        render();
    };
    const mediaUrl = (c) => {
        if (!c) return null;
        if (c.image) return itemUrl(c.image);
        if (c.file && c.kind !== "none") return fileUrl(c.file);
        return null;
    };

    const root = document.createElement("div");
    root.style.cssText = "width:100%;height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:#171b22;color:#e4e9ef;font:12px sans-serif;box-sizing:border-box;border-radius:6px";
    root.tabIndex = 0;
    root.setAttribute("aria-label", "Magik Prompt Preview");
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;gap:5px;flex-wrap:wrap;align-items:center;padding:6px;background:#252d39;flex:none";
    root.append(bar);
    function button(parent, label, title, action) {
        const el = document.createElement("button");
        el.textContent = label; el.title = title;
        el.style.cssText = "cursor:pointer;background:#344459;color:#eef4ff;border:1px solid #536780;border-radius:4px;padding:4px 7px";
        el.onclick = action;
        parent.append(el);
        return el;
    }
    button(bar, "◀", "Previous prompt (Left arrow)", () => navigate(-1));
    button(bar, "▶", "Next prompt (Right arrow)", () => navigate(1));
    const indexLabel = document.createElement("span");
    indexLabel.style.cssText = "min-width:44px;text-align:center;color:#9fb2c8";
    bar.append(indexLabel);
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Search prompts… ( / )";
    search.value = state().query;
    search.style.cssText = "flex:1;min-width:70px;background:#293446;color:#eef4ff;border:1px solid #3a4658;border-radius:4px;padding:4px 7px";
    search.addEventListener("input", () => { state().query = search.value; render(); });
    search.addEventListener("keydown", (e) => e.stopPropagation());
    search.addEventListener("pointerdown", (e) => e.stopPropagation());
    bar.append(search);
    const sortSelect = document.createElement("select");
    for (const [value, label] of SORTS) {
        const option = document.createElement("option");
        option.value = value; option.textContent = label;
        sortSelect.append(option);
    }
    sortSelect.value = state().sort;
    sortSelect.title = "Deck order; the prompts output follows this order on the next run";
    sortSelect.style.cssText = "background:#293446;color:#eef4ff;border:1px solid #3a4658;border-radius:4px;padding:3px";
    sortSelect.addEventListener("pointerdown", (e) => e.stopPropagation());
    sortSelect.onchange = () => { state().sort = sortSelect.value; applySort(); render(); };
    bar.append(sortSelect);
    const moveBack = button(bar, "⇤", "Move the selected card earlier (manual sort)", () => move(-1));
    const moveFwd = button(bar, "⇥", "Move the selected card later (manual sort)", () => move(1));
    const favBtn = button(bar, "★", "Toggle favorite on the selected prompt (f)", toggleFav);
    button(bar, "Copy", "Copy the selected prompt", () => { const c = card(state().selected); if (c) copyText(c.prompt); });
    button(bar, "Open", "Open the selected media in a new tab", () => {
        const url = mediaUrl(card(state().selected));
        if (url) window.open(url, "_blank", "noopener,noreferrer");
    });
    button(bar, "Upload", "Upload an image or video into input/magik_prompt_preview/", () => fileInput.click());
    const sideBtn = button(bar, "⇄", "Toggle which side the media is on", () => {
        const w = widget("media_side");
        if (w) w.value = w.value === "left" ? "right" : "left";
        state().mediaSide = widget("media_side")?.value ?? "left";
        render();
    });
    const modeBtn = button(bar, "", "Toggle compact mode (c)", () => {
        const w = widget("mode");
        if (w) w.value = state().compact ? "side_by_side" : "compact";
        syncMode();
    });
    const status = document.createElement("span");
    status.style.cssText = "color:#7fd0a0;flex-basis:100%;min-height:0";
    bar.append(status);
    const setStatus = (msg) => {
        status.textContent = msg || "";
        clearTimeout(statusTimer);
        if (msg) statusTimer = setTimeout(() => { if (!disposed) status.textContent = ""; }, 4000);
    };
    const copyText = async (text) => {
        try {
            if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
            await navigator.clipboard.writeText(text);
            setStatus("Copied");
        } catch {
            const ta = document.createElement("textarea");
            ta.value = text;
            Object.assign(ta.style, { position: "absolute", opacity: "0", width: "1px", height: "1px" });
            root.append(ta);
            ta.select();
            try { setStatus(document.execCommand("copy") ? "Copied" : "Copy failed — select the text and press Ctrl+C"); }
            catch { setStatus("Copy failed — select the text and press Ctrl+C"); }
            finally { ta.remove(); }
        }
    };

    const body = document.createElement("div");
    body.style.cssText = "flex:1;min-height:0;display:flex;overflow:hidden";
    root.append(body);
    const mediaPane = document.createElement("div");
    mediaPane.style.cssText = "position:relative;flex:1;min-width:0;min-height:0;overflow:hidden;background:#101318";
    const promptPane = document.createElement("div");
    promptPane.style.cssText = "width:46%;flex:none;overflow:auto;padding:10px;box-sizing:border-box;background:#1d232d;border-left:1px solid #303a48;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;line-height:1.4;cursor:text";
    promptPane.setAttribute("aria-label", "Prompt text");
    for (const ev of ["pointerdown", "mousedown", "dblclick", "wheel", "keydown"]) {
        promptPane.addEventListener(ev, (e) => e.stopPropagation());
    }
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:absolute;inset:0;display:none;flex-direction:column;gap:6px;background:rgba(16,19,24,0.94);padding:10px;box-sizing:border-box;z-index:5";
    for (const ev of ["pointerdown", "mousedown", "wheel"]) overlay.addEventListener(ev, (e) => e.stopPropagation());
    const overlayText = document.createElement("div");
    overlayText.style.cssText = "flex:1;min-height:0;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text";
    const overlayBar = document.createElement("div");
    overlayBar.style.cssText = "display:flex;gap:5px;flex:none";
    button(overlayBar, "Copy", "Copy the prompt", () => { const c = card(state().selected); if (c) copyText(c.prompt); });
    button(overlayBar, "✕", "Hide the prompt", () => { const s = state(); delete s.overlay[s.selected]; render(); });
    overlay.append(overlayText, overlayBar);
    const strip = document.createElement("div");
    strip.style.cssText = "flex:none;display:flex;gap:5px;overflow-x:auto;padding:5px;background:#252d39;min-height:74px;max-height:86px";
    root.append(strip);
    const infoBtn = document.createElement("button");
    infoBtn.textContent = "ⓘ";
    infoBtn.title = "Show/hide the prompt (also: click the media)";
    infoBtn.style.cssText = "position:absolute;top:6px;right:6px;z-index:6;cursor:pointer;background:#344459;color:#eef4ff;border:1px solid #536780;border-radius:4px;padding:2px 7px";
    infoBtn.onclick = (e) => { e.stopPropagation(); toggleOverlay(); };
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = [...IMAGE_EXTS, ...VIDEO_EXTS].map((e) => "." + e).join(",");
    fileInput.style.display = "none";
    root.append(fileInput);

    const imgEl = (src, token, lazy = false) => {
        const img = document.createElement("img");
        img.alt = "media";
        img.draggable = false;
        img.loading = lazy ? "lazy" : "eager";
        img.style.cssText = "display:block;width:100%;height:100%;object-fit:contain;pointer-events:none";
        img.onerror = () => { if (disposed || token !== serial) return; img.style.display = "none"; };
        img.src = src;
        return img;
    };
    const toggleOverlay = () => {
        const s = state();
        if (!s.selected) return;
        if (s.overlay[s.selected]) delete s.overlay[s.selected]; else s.overlay[s.selected] = true;
        render();
    };
    mediaPane.addEventListener("click", (e) => {
        if (state().compact && e.target === mediaPane) toggleOverlay();
    });
    mediaPane.addEventListener("dblclick", () => openFullscreen(card(state().selected)));

    const applyPromptStyle = () => {
        const font = widget("font")?.value ?? "Monospace";
        const size = Number(widget("font_size")?.value);
        const family = GENERIC_FONTS[font] ?? `"${font}", ${/Mono|Courier/.test(font) ? "monospace" : /Serif|Georgia/.test(font) ? "serif" : "sans-serif"}`;
        for (const el of [promptPane, overlayText]) {
            el.style.fontFamily = family;
            el.style.fontSize = `${Math.min(64, Math.max(6, Number.isFinite(size) ? size : 14))}px`;
        }
    };
    const applySize = () => {
        const compact = state().compact;
        node.setSize([Math.max(node.size[0], compact ? 320 : 560), Math.max(node.size[1], compact ? 260 : 430)]);
    };
    const syncMode = () => {
        const s = state();
        s.compact = (widget("mode")?.value ?? "side_by_side") === "compact";
        s.mediaSide = widget("media_side")?.value ?? "left";
        applySize();
        render();
    };

    function render() {
        if (disposed) return;
        const token = ++serial;
        const s = state();
        mergeOrder();
        const visible = visibleCards();
        let current = card(s.selected);
        if (!current || (s.query.trim() && !visible.some((c) => c.key === current.key))) {
            current = visible.at(-1) || s.cards.at(-1) || null;
        }
        if (current) s.selected = current.key;
        const pos = visible.findIndex((c) => c.key === s.selected);
        indexLabel.textContent = visible.length ? `${pos + 1}/${visible.length}` : "0/0";
        favBtn.style.background = current && fav(current.key) ? "#6d5a1f" : "#344459";
        moveBack.style.display = moveFwd.style.display = s.sort === "manual" ? "" : "none";
        modeBtn.textContent = s.compact ? "Split" : "Compact";
        modeBtn.title = s.compact ? "Show prompt and media side by side (c)" : "Show only the media; click it for the prompt (c)";

        body.replaceChildren();
        promptPane.style.display = s.compact ? "none" : "";
        if (s.mediaSide === "right") body.append(promptPane, mediaPane);
        else body.append(mediaPane, promptPane);

        mediaPane.replaceChildren();
        if (current) {
            let el = null;
            if (current.image) el = imgEl(itemUrl(current.image), token);
            else if (current.kind === "image" && current.file) el = imgEl(fileUrl(current.file), token);
            else if (current.kind === "video" && current.file) {
                el = document.createElement("video");
                el.controls = true; el.loop = true; el.muted = true; el.playsInline = true;
                el.preload = "metadata";
                el.src = fileUrl(current.file);
                el.style.cssText = "display:block;width:100%;height:100%;object-fit:contain;background:#000";
            }
            if (el) mediaPane.append(el);
            else {
                const ph = document.createElement("div");
                ph.textContent = "No media — connect an images input or pick/upload a file.";
                ph.style.cssText = "position:absolute;inset:10px;color:#8fa0b5;pointer-events:none";
                mediaPane.append(ph);
            }
        } else {
            const ph = document.createElement("div");
            ph.textContent = "Run the workflow to load prompts.";
            ph.style.cssText = "position:absolute;inset:10px;color:#8fa0b5;pointer-events:none";
            mediaPane.append(ph);
        }
        mediaPane.append(overlay);
        if (s.compact) mediaPane.append(infoBtn);
        const showOverlay = s.compact && current && !!s.overlay[current.key];
        overlay.style.display = showOverlay ? "flex" : "none";
        if (showOverlay) overlayText.textContent = current.prompt;

        promptPane.textContent = current ? current.prompt : "";
        applyPromptStyle();

        strip.replaceChildren();
        for (const c of visible) {
            const cell = document.createElement("button");
            cell.title = c.prompt.slice(0, 300);
            cell.style.cssText = `position:relative;flex:none;width:72px;height:64px;overflow:hidden;cursor:pointer;padding:0;background:#202733;border:2px solid ${c.key === s.selected ? "#78c8df" : "#3a4658"}`;
            if (c.image) cell.append(imgEl(itemUrl(c.image, true), token, true));
            else if (c.kind === "image" && c.file) cell.append(imgEl(fileUrl(c.file), token, true));
            else if (c.kind === "video" && c.file) {
                const v = document.createElement("video");
                v.muted = true; v.playsInline = true; v.preload = "metadata";
                v.src = fileUrl(c.file);
                v.style.cssText = "width:100%;height:100%;object-fit:cover;pointer-events:none";
                cell.append(v);
                const play = document.createElement("span");
                play.textContent = "▶";
                play.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;text-shadow:0 0 4px #000;pointer-events:none";
                cell.append(play);
            } else {
                const aa = document.createElement("span");
                aa.textContent = "Aa";
                aa.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#9fb2c8;pointer-events:none";
                cell.append(aa);
            }
            cell.onclick = () => { s.selected = c.key; render(); };
            strip.append(cell);
        }
    }

    function openFullscreen(c) {
        if (!c || disposed) return;
        const previousFocus = document.activeElement;
        const dialog = document.createElement("dialog");
        dialog.setAttribute("aria-label", "Magik Prompt Preview — expanded media");
        Object.assign(dialog.style, {
            width: "94vw", height: "92vh", maxWidth: "94vw", maxHeight: "92vh",
            padding: "16px", boxSizing: "border-box", border: "1px solid #666",
            borderRadius: "12px", background: "var(--comfy-menu-bg, #202020)",
            color: "var(--input-text, #eee)", overflow: "hidden",
        });
        const layout = document.createElement("div");
        Object.assign(layout.style, { display: "flex", flexDirection: "column", height: "100%", gap: "10px", minHeight: "0" });
        const toolbar = document.createElement("div");
        Object.assign(toolbar.style, { display: "flex", gap: "8px", flex: "none" });
        const copy = document.createElement("button");
        copy.textContent = "Copy prompt";
        const close = document.createElement("button");
        close.textContent = "Close";
        copy.onclick = () => copyText(c.prompt);
        close.onclick = () => dialog.close();
        toolbar.append(copy, close);
        const mediaBox = document.createElement("div");
        Object.assign(mediaBox.style, { flex: "1", minHeight: "0", display: "flex", alignItems: "center", justifyContent: "center", background: "#101318", overflow: "hidden" });
        const url = mediaUrl(c);
        if (c.image || (c.kind === "image" && c.file)) {
            const img = document.createElement("img");
            img.src = url;
            Object.assign(img.style, { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" });
            mediaBox.append(img);
        } else if (c.kind === "video" && c.file) {
            const v = document.createElement("video");
            v.src = url; v.controls = true; v.autoplay = true; v.loop = true; v.muted = true; v.playsInline = true;
            Object.assign(v.style, { maxWidth: "100%", maxHeight: "100%" });
            mediaBox.append(v);
        } else {
            mediaBox.textContent = "No media for this prompt.";
        }
        const text = document.createElement("div");
        text.textContent = c.prompt;
        Object.assign(text.style, { flex: "none", maxHeight: "30%", overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", userSelect: "text" });
        layout.append(toolbar, mediaBox, text);
        dialog.append(layout);
        document.body.append(dialog);
        dialog.showModal();
        dialog.addEventListener("click", (event) => {
            if (event.target !== dialog) return;
            const bounds = dialog.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
        });
        dialog.addEventListener("close", () => {
            dialog.remove();
            if (previousFocus?.isConnected) previousFocus.focus();
        }, { once: true });
    }

    const refreshMedia = async () => {
        const res = await fetch(api.apiURL("/magik_prompt_preview/api/media"));
        const data = await res.json().catch(() => ({}));
        const w = widget("media");
        if (w && Array.isArray(data.media)) {
            w.options ||= {};
            w.options.values = data.media;
        }
    };
    fileInput.addEventListener("change", async () => {
        const f = fileInput.files?.[0];
        fileInput.value = "";
        if (!f) return;
        setStatus("Uploading…");
        try {
            const fd = new FormData();
            fd.append("file", f);
            const res = await fetch(api.apiURL("/magik_prompt_preview/api/upload"), { method: "POST", body: fd });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) { setStatus(data.error || `Upload failed (${res.status})`); return; }
            await refreshMedia();
            const w = widget("media");
            if (w) w.value = data.media;
            if (lastMessage) {
                lastMessage = { ...lastMessage, media: data.media, media_kind: kindOf(data.media) };
                state().cards = buildCards(lastMessage);
                mergeOrder();
            }
            setStatus(`Uploaded ${data.media}`);
            render();
        } catch (err) {
            setStatus(`Upload failed: ${err?.message || err}`);
        }
    });

    root.addEventListener("keydown", (e) => {
        if (e.target === search) return;
        if (e.key === "ArrowLeft") { navigate(-1); e.preventDefault(); }
        else if (e.key === "ArrowRight") { navigate(1); e.preventDefault(); }
        else if (e.key === "f" || e.key === "F") toggleFav();
        else if (e.key === "c" || e.key === "C") {
            const w = widget("mode");
            if (w) w.value = state().compact ? "side_by_side" : "compact";
            syncMode();
        } else if (e.key === "/") { search.focus(); e.preventDefault(); }
    });

    const wrap = (name, fn) => {
        const w = widget(name);
        if (!w) return;
        const cb = w.callback;
        w.callback = function () {
            const r = cb?.apply(this, arguments);
            fn(this.value);
            return r;
        };
    };
    wrap("mode", syncMode);
    wrap("media_side", () => { state().mediaSide = widget("media_side")?.value ?? "left"; render(); });
    wrap("media", (v) => {
        if (lastMessage) {
            lastMessage = { ...lastMessage, media: String(v || ""), media_kind: kindOf(String(v || "")) };
            state().cards = buildCards(lastMessage);
            mergeOrder();
            render();
        }
    });
    wrap("font", () => { applyPromptStyle(); });
    wrap("font_size", () => { applyPromptStyle(); });
    const sortOrderWidget = widget("sort_order");
    if (sortOrderWidget) sortOrderWidget.computeSize = () => [0, -4];

    // Let ComfyUI own DOM placement and scaling; never resize its parent wrapper.
    const dom = node.addDOMWidget("magik_prompt_preview", "custom", root, { serialize: false, hideOnZoom: false });
    dom.computeSize = (width) => [width, state().compact ? 260 : 420];
    dom.options ||= {};
    dom.options.getMinHeight = () => (state().compact ? 220 : 360);

    const executed = node.onExecuted;
    node.onExecuted = function (message) {
        executed?.apply(this, arguments);
        const msg = message?.magik_prompt_preview;
        if (!msg) return;
        lastMessage = msg;
        state().cards = buildCards(msg);
        mergeOrder();
        render();
    };
    const configured = node.onConfigure;
    node.onConfigure = function () {
        configured?.apply(this, arguments);
        search.value = state().query;
        sortSelect.value = state().sort;
        syncMode();
    };
    // Restore after the complete configure call: onConfigure may run before
    // LiteGraph has assigned the saved widget values.
    const configure = node.configure;
    node.configure = function (info) {
        const r = configure?.apply(this, arguments);
        syncMode();
        return r;
    };
    const removed = node.onRemoved;
    node.onRemoved = function () {
        disposed = true;
        serial++;
        clearTimeout(statusTimer);
        root.querySelectorAll("img,video").forEach((el) => { el.removeAttribute("src"); });
        root.remove();
        removed?.apply(this, arguments);
    };
    syncMode();
}
