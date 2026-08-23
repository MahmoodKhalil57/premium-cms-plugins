/**
 * Design studio: a small canvas editor for `design` fields. Layers (text,
 * preset prints, uploaded images, shapes) on a print area drawn over the
 * garment mockup. Produces a DesignDoc (validated again on the server) and
 * a PNG preview uploaded through the store's upload route.
 */
import { DESIGN_FONTS, DESIGN_LIMITS, type DesignConfig, type DesignDoc, type DesignLayer, validateDesign } from "./fields-model";

export interface StudioResult {
	design: DesignDoc;
	previewMediaId?: string;
	previewDataUrl?: string;
}
export interface StudioOptions {
	/** POST endpoint of the commerce `upload` route. */
	uploadUrl: string;
	money?: (delta: number) => string;
	title?: string;
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const uid = () => Math.random().toString(36).slice(2, 10);

const CSS = `
.pbx{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font:14px/1.4 system-ui,sans-serif;color:#1a1a1a}
.pbx *{box-sizing:border-box}
.pbx button{color:inherit;text-transform:none;letter-spacing:normal}
.pbx__win{background:#fff;border-radius:12px;width:min(1100px,96vw);height:min(760px,94vh);display:grid;grid-template-rows:auto 1fr auto;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35)}
.pbx__head{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid #e5e5e5}
.pbx__head h2{margin:0;font-size:16px}
.pbx__head .pbx__hint{color:#666;font-size:12px;margin-inline-start:auto}
.pbx__body{display:grid;grid-template-columns:1fr 300px;min-height:0}
.pbx__stage{position:relative;background:#f3f3f3;display:flex;align-items:center;justify-content:center;overflow:hidden}
.pbx__stage canvas{max-width:100%;max-height:100%;touch-action:none;cursor:move;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.12)}
.pbx__side{border-inline-start:1px solid #e5e5e5;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:12px}
.pbx__side h3{margin:8px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#666}
.pbx__row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.pbx__btn{font:inherit;font-size:13px;padding:6px 10px;border-radius:6px;border:1px solid #ccc;background:#fff;color:#1a1a1a;cursor:pointer;line-height:1.2}
.pbx__btn--primary{background:#111;color:#fff !important;border-color:#111}
.pbx__btn[disabled]{opacity:.5;cursor:default}
.pbx input[type=text],.pbx select,.pbx input[type=number]{font:inherit;padding:5px 8px;border:1px solid #ccc;border-radius:6px;width:100%}
.pbx input[type=range]{width:100%}
.pbx__presets{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.pbx__presets button{padding:4px;border:1px solid #ddd;border-radius:6px;background:#fff;cursor:pointer;min-height:60px}
.pbx__presets img{width:100%;aspect-ratio:1;object-fit:contain;display:block}
.pbx__layers{display:flex;flex-direction:column;gap:4px}
.pbx__layer{display:flex;align-items:center;gap:6px;padding:4px 6px;border:1px solid #e5e5e5;border-radius:6px;cursor:pointer;font-size:13px}
.pbx__layer.is-active{border-color:#111;background:#f7f7f7}
.pbx__layer span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pbx__layer button{font:inherit;font-size:12px;border:0;background:none;cursor:pointer;color:#666;padding:2px 4px}
.pbx__colors{display:flex;gap:6px;flex-wrap:wrap}
.pbx__colors button{width:22px;height:22px;border-radius:50%;border:1px solid #ccc;cursor:pointer}
.pbx__foot{display:flex;gap:8px;align-items:center;padding:10px 16px;border-top:1px solid #e5e5e5}
.pbx__foot .pbx__status{color:#b42318;font-size:12px;flex:1}
.pbx__foot .pbx__price{font-weight:600}
@media(max-width:760px){.pbx__win{height:100vh;width:100vw;border-radius:0}.pbx__body{grid-template-columns:1fr}.pbx__side{border-inline-start:0;border-top:1px solid #e5e5e5;max-height:45vh}}
`;

interface Loaded {
	img: HTMLImageElement;
	tainted: boolean;
}

export function openDesignStudio(config: DesignConfig, existing: DesignDoc | null, opts: StudioOptions): Promise<StudioResult | null> {
	return new Promise((resolve) => {
		const areas = config.areas ?? [];
		if (areas.length === 0) return resolve(null);
		const fonts = config.fonts?.length ? config.fonts : DESIGN_FONTS;
		const colors = config.colors?.length ? config.colors : ["#111111", "#ffffff", "#e63946", "#2a9d8f", "#e9c46a", "#1d3557", "#f4a261", "#8338ec"];
		const maxLayers = Math.min(config.maxLayers ?? DESIGN_LIMITS.maxLayers, DESIGN_LIMITS.maxLayers);
		let area = areas.find((a) => a.id === existing?.area) ?? areas[0]!;
		let doc: DesignDoc = existing && existing.area === area.id ? JSON.parse(JSON.stringify(existing)) : { version: 1, area: area.id, width: area.width, height: area.height, layers: [] };
		let selected: string | null = doc.layers[0]?.id ?? null;
		const images = new Map<string, Loaded>();
		const uploads = new Map<string, string>(); // mediaId → object/remote URL

		const root = document.createElement("div");
		root.className = "pbx";
		root.innerHTML = `<style>${CSS}</style><div class="pbx__win" role="dialog" aria-modal="true" aria-label="Design studio">
			<div class="pbx__head"><h2>${esc(opts.title ?? "Design studio")}</h2>${areas.length > 1 ? `<select data-area>${areas.map((a) => `<option value="${esc(a.id)}"${a.id === area.id ? " selected" : ""}>${esc(a.label)}</option>`).join("")}</select>` : `<span>${esc(area.label)}</span>`}<span class="pbx__hint">Drag to move · wheel/slider to resize · keep inside the dashed print area</span></div>
			<div class="pbx__body"><div class="pbx__stage"><canvas data-canvas></canvas></div><div class="pbx__side">
				${config.allowText !== false ? `<h3>Text</h3><div class="pbx__row"><input type="text" data-text placeholder="Your text" maxlength="${DESIGN_LIMITS.maxText}"><button class="pbx__btn" data-add-text>Add text</button></div>` : ""}
				${config.presets?.length ? `<h3>Prints</h3><div class="pbx__presets">${config.presets.map((p) => `<button type="button" data-preset="${esc(p.id)}" title="${esc(p.label)}${p.priceDelta && opts.money ? ` ${opts.money(p.priceDelta)}` : ""}"><img src="${esc(p.image)}" alt="${esc(p.label)}" crossorigin="anonymous"></button>`).join("")}</div>` : ""}
				${config.allowUpload !== false ? `<h3>Your image</h3><div class="pbx__row"><input type="file" data-upload accept="image/png,image/jpeg,image/webp"><span data-upload-status style="font-size:12px;color:#666"></span></div>` : ""}
				${config.allowShapes !== false ? `<h3>Shapes</h3><div class="pbx__row"><button class="pbx__btn" data-add-shape="rect">Rectangle</button><button class="pbx__btn" data-add-shape="circle">Circle</button></div>` : ""}
				<h3>Layers</h3><div class="pbx__layers" data-layers></div>
				<h3>Selected</h3><div data-props></div>
			</div></div>
			<div class="pbx__foot"><span class="pbx__status" data-status></span><span class="pbx__price" data-price></span><button class="pbx__btn" data-cancel>Cancel</button><button class="pbx__btn pbx__btn--primary" data-save>Use this design</button></div>
		</div>`;
		document.body.appendChild(root);
		const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
		const canvas = $<HTMLCanvasElement>("[data-canvas]");
		const ctx = canvas.getContext("2d")!;
		const status = $<HTMLElement>("[data-status]");

		/* ---- assets ---- */
		const loadImage = (key: string, url: string): Promise<Loaded> => {
			const cached = images.get(key);
			if (cached) return Promise.resolve(cached);
			return new Promise((res) => {
				const img = new Image();
				img.crossOrigin = "anonymous";
				img.onload = () => {
					const l = { img, tainted: false };
					images.set(key, l);
					res(l);
				};
				img.onerror = () => {
					// Retry without CORS: it will draw, but the preview export may be blocked.
					const img2 = new Image();
					img2.onload = () => {
						const l = { img: img2, tainted: true };
						images.set(key, l);
						res(l);
					};
					img2.onerror = () => res({ img: img2, tainted: true });
					img2.src = url;
				};
				img.src = url;
			});
		};
		const layerImageUrl = (l: DesignLayer): string | null => {
			if (l.type !== "image") return null;
			const src = l.source;
			if (src.kind === "preset") return config.presets?.find((p) => p.id === src.id)?.image ?? null;
			return uploads.get(src.mediaId) ?? null;
		};
		const mockup = area.previewImage ? loadImage(`mockup:${area.id}`, area.previewImage) : Promise.resolve(null);

		/* ---- geometry: canvas shows the mockup; the print area is the doc's coordinate space ---- */
		const stage = { w: 0, h: 0 };
		let box = { x: 0, y: 0, w: 0, h: 0 }; // print area in canvas px
		function layout() {
			const host = $<HTMLElement>(".pbx__stage");
			const maxW = host.clientWidth - 24;
			const maxH = host.clientHeight - 24;
			const ratio = area.previewImage && area.printBox ? 1 : area.width / area.height;
			let w = maxW;
			let h = w / ratio;
			if (h > maxH) {
				h = maxH;
				w = h * ratio;
			}
			stage.w = Math.floor(w);
			stage.h = Math.floor(h);
			canvas.width = stage.w;
			canvas.height = stage.h;
			if (area.previewImage && area.printBox) {
				box = { x: (area.printBox.x / 100) * stage.w, y: (area.printBox.y / 100) * stage.h, w: (area.printBox.w / 100) * stage.w, h: (area.printBox.h / 100) * stage.h };
				// keep the print area's aspect ratio inside the box
				const r = area.width / area.height;
				if (box.w / box.h > r) {
					const nw = box.h * r;
					box.x += (box.w - nw) / 2;
					box.w = nw;
				} else {
					const nh = box.w / r;
					box.y += (box.h - nh) / 2;
					box.h = nh;
				}
			} else box = { x: 0, y: 0, w: stage.w, h: stage.h };
		}
		const scale = () => box.w / doc.width;

		/* ---- drawing ---- */
		function drawLayers(c: CanvasRenderingContext2D, s: number, ox: number, oy: number, withSelection: boolean) {
			for (const l of doc.layers) {
				c.save();
				const cx = ox + l.x * s;
				const cy = oy + l.y * s;
				if (l.rotation) {
					c.translate(cx, cy);
					c.rotate((l.rotation * Math.PI) / 180);
					c.translate(-cx, -cy);
				}
				if (l.type === "text") {
					c.font = `${l.weight === "bold" ? "bold " : ""}${l.size * s}px "${l.font}"`;
					c.fillStyle = l.color;
					c.textBaseline = "top";
					c.textAlign = l.align === "center" ? "center" : l.align === "right" ? "right" : "left";
					c.fillText(l.text, cx, cy);
				} else if (l.type === "image") {
					const url = layerImageUrl(l);
					const loaded = url ? images.get(url) : undefined;
					if (loaded?.img.complete && loaded.img.naturalWidth) {
						const iw = loaded.img.naturalWidth;
						const ih = loaded.img.naturalHeight;
						const r = Math.min((l.w * s) / iw, (l.h * s) / ih);
						const dw = iw * r;
						const dh = ih * r;
						c.drawImage(loaded.img, cx + (l.w * s - dw) / 2, cy + (l.h * s - dh) / 2, dw, dh);
					} else {
						c.strokeStyle = "#999";
						c.strokeRect(cx, cy, l.w * s, l.h * s);
					}
				} else if (l.type === "shape") {
					c.fillStyle = l.fill;
					if (l.shape === "circle") {
						c.beginPath();
						c.ellipse(cx + (l.w * s) / 2, cy + (l.h * s) / 2, (l.w * s) / 2, (l.h * s) / 2, 0, 0, Math.PI * 2);
						c.fill();
					} else c.fillRect(cx, cy, l.w * s, l.h * s);
				}
				if (withSelection && l.id === selected) {
					const b = bounds(l, s, ox, oy);
					c.setLineDash([4, 3]);
					c.strokeStyle = "#2563eb";
					c.lineWidth = 1;
					c.strokeRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4);
				}
				c.restore();
			}
		}
		function bounds(l: DesignLayer, s: number, ox: number, oy: number) {
			if (l.type === "text") {
				ctx.font = `${l.weight === "bold" ? "bold " : ""}${l.size * s}px "${l.font}"`;
				const w = ctx.measureText(l.text).width;
				const x = ox + l.x * s - (l.align === "center" ? w / 2 : l.align === "right" ? w : 0);
				return { x, y: oy + l.y * s, w, h: l.size * s * 1.2 };
			}
			return { x: ox + l.x * s, y: oy + l.y * s, w: l.w * s, h: l.h * s };
		}
		async function draw() {
			const m = await mockup;
			ctx.clearRect(0, 0, stage.w, stage.h);
			if (m?.img.naturalWidth) ctx.drawImage(m.img, 0, 0, stage.w, stage.h);
			else {
				ctx.fillStyle = "#fff";
				ctx.fillRect(0, 0, stage.w, stage.h);
			}
			if (doc.background) {
				ctx.fillStyle = doc.background;
				ctx.fillRect(box.x, box.y, box.w, box.h);
			}
			ctx.save();
			ctx.beginPath();
			ctx.rect(box.x, box.y, box.w, box.h);
			ctx.clip();
			drawLayers(ctx, scale(), box.x, box.y, true);
			ctx.restore();
			ctx.setLineDash([6, 4]);
			ctx.strokeStyle = "rgba(0,0,0,.45)";
			ctx.lineWidth = 1;
			ctx.strokeRect(box.x, box.y, box.w, box.h);
			ctx.setLineDash([]);
			renderLayers();
			renderProps();
			renderPrice();
		}

		/* ---- side panel ---- */
		const layersEl = $<HTMLElement>("[data-layers]");
		const propsEl = $<HTMLElement>("[data-props]");
		function layerName(l: DesignLayer) {
			if (l.type === "text") return `“${l.text}”`;
			if (l.type === "image") {
				const src = l.source;
				return src.kind === "preset" ? `Print: ${config.presets?.find((p) => p.id === src.id)?.label ?? src.id}` : "Your image";
			}
			return l.shape === "circle" ? "Circle" : "Rectangle";
		}
		function renderLayers() {
			layersEl.innerHTML = doc.layers.length
				? [...doc.layers]
						.reverse()
						.map((l) => `<div class="pbx__layer${l.id === selected ? " is-active" : ""}" data-select="${l.id}"><span>${esc(layerName(l))}</span><button type="button" data-up="${l.id}" title="Bring forward">▲</button><button type="button" data-down="${l.id}" title="Send back">▼</button><button type="button" data-del="${l.id}" title="Remove">✕</button></div>`)
						.join("")
				: `<p style="color:#666;font-size:12px;margin:0">Add text, a print, your own image or a shape.</p>`;
		}
		function renderProps() {
			const l = doc.layers.find((x) => x.id === selected);
			if (!l) {
				propsEl.innerHTML = `<p style="color:#666;font-size:12px;margin:0">Select a layer to edit it.</p>`;
				return;
			}
			const colorRow = (current: string, key: "color" | "fill") =>
				`<div class="pbx__colors">${colors.map((c) => `<button type="button" data-color="${esc(c)}" data-color-key="${key}" style="background:${esc(c)};outline:${c.toLowerCase() === current.toLowerCase() ? "2px solid #2563eb" : "none"}" title="${esc(c)}"></button>`).join("")}<input type="color" data-color-input="${key}" value="${esc(current.length === 7 ? current : "#111111")}" style="width:30px;height:24px;padding:0;border:1px solid #ccc;border-radius:6px;background:none"></div>`;
			if (l.type === "text") {
				propsEl.innerHTML = `<input type="text" data-prop="text" value="${esc(l.text)}" maxlength="${DESIGN_LIMITS.maxText}"><div class="pbx__row" style="margin-top:6px"><select data-prop="font">${fonts.map((f) => `<option${f === l.font ? " selected" : ""}>${esc(f)}</option>`).join("")}</select></div><div class="pbx__row" style="margin-top:6px"><select data-prop="align"><option value="left"${l.align === "left" ? " selected" : ""}>Left</option><option value="center"${!l.align || l.align === "center" ? " selected" : ""}>Center</option><option value="right"${l.align === "right" ? " selected" : ""}>Right</option></select><select data-prop="weight"><option value="normal"${l.weight !== "bold" ? " selected" : ""}>Regular</option><option value="bold"${l.weight === "bold" ? " selected" : ""}>Bold</option></select></div><label style="font-size:12px">Size <input type="range" data-prop="size" min="8" max="${Math.min(DESIGN_LIMITS.maxFontSize, doc.height)}" value="${l.size}"></label><label style="font-size:12px">Rotation <input type="range" data-prop="rotation" min="-180" max="180" value="${l.rotation ?? 0}"></label>${colorRow(l.color, "color")}`;
			} else {
				propsEl.innerHTML = `<label style="font-size:12px">Size <input type="range" data-prop="w" min="20" max="${doc.width}" value="${l.w}"></label><label style="font-size:12px">Rotation <input type="range" data-prop="rotation" min="-180" max="180" value="${l.rotation ?? 0}"></label>${l.type === "shape" ? colorRow(l.fill, "fill") : ""}`;
			}
		}
		function renderPrice() {
			const el = $<HTMLElement>("[data-price]");
			if (!opts.money) return (el.textContent = "");
			const presets = new Set<string>();
			let text = false;
			let upload = false;
			for (const l of doc.layers) {
				if (l.type === "text") text = true;
				if (l.type === "image" && l.source.kind === "preset") presets.add(l.source.id);
				if (l.type === "image" && l.source.kind === "upload") upload = true;
			}
			let delta = 0;
			for (const id of presets) delta += config.presets?.find((p) => p.id === id)?.priceDelta ?? 0;
			if (text) delta += config.textPriceDelta ?? 0;
			if (upload) delta += config.uploadPriceDelta ?? 0;
			el.textContent = delta ? `Design extras: ${opts.money(delta)}` : "";
		}

		/* ---- editing ---- */
		const sel = () => doc.layers.find((x) => x.id === selected);
		function add(layer: DesignLayer) {
			if (doc.layers.length >= maxLayers) {
				status.textContent = `At most ${maxLayers} layers.`;
				return;
			}
			doc.layers.push(layer);
			selected = layer.id;
			status.textContent = "";
			void draw();
		}
		root.addEventListener("click", async (e) => {
			const t = e.target as HTMLElement;
			const b = t.closest<HTMLElement>("[data-add-text],[data-preset],[data-add-shape],[data-select],[data-up],[data-down],[data-del],[data-color],[data-cancel],[data-save]");
			if (!b) return;
			if (b.dataset.addText !== undefined) {
				const input = $<HTMLInputElement>("[data-text]");
				const text = input.value.trim();
				if (!text) return input.focus();
				add({ id: uid(), type: "text", text, font: fonts[0]!, size: Math.round(doc.width / 8), color: colors[0]!, x: doc.width / 2, y: doc.height / 3, align: "center", weight: "bold" });
				input.value = "";
			} else if (b.dataset.preset) {
				const p = config.presets!.find((x) => x.id === b.dataset.preset)!;
				await loadImage(p.image, p.image);
				const w = Math.round(doc.width * 0.6);
				add({ id: uid(), type: "image", source: { kind: "preset", id: p.id }, x: Math.round((doc.width - w) / 2), y: Math.round(doc.height * 0.15), w, h: w });
			} else if (b.dataset.addShape) {
				const w = Math.round(doc.width * 0.4);
				add({ id: uid(), type: "shape", shape: b.dataset.addShape as "rect" | "circle", fill: colors[2] ?? "#e63946", x: Math.round((doc.width - w) / 2), y: Math.round((doc.height - w) / 2), w, h: w });
			} else if (b.dataset.select) {
				selected = b.dataset.select;
				void draw();
			} else if (b.dataset.up || b.dataset.down) {
				const id = b.dataset.up ?? b.dataset.down!;
				const i = doc.layers.findIndex((x) => x.id === id);
				const j = b.dataset.up ? i + 1 : i - 1;
				if (i >= 0 && j >= 0 && j < doc.layers.length) [doc.layers[i], doc.layers[j]] = [doc.layers[j]!, doc.layers[i]!];
				e.stopPropagation();
				void draw();
			} else if (b.dataset.del) {
				doc.layers = doc.layers.filter((x) => x.id !== b.dataset.del);
				if (selected === b.dataset.del) selected = doc.layers[0]?.id ?? null;
				e.stopPropagation();
				void draw();
			} else if (b.dataset.color) {
				const l = sel();
				if (l?.type === "text") l.color = b.dataset.color;
				if (l?.type === "shape") l.fill = b.dataset.color;
				void draw();
			} else if (b.dataset.cancel !== undefined) close(null);
			else if (b.dataset.save !== undefined) await save();
		});
		root.addEventListener("input", (e) => {
			const t = e.target as HTMLInputElement | HTMLSelectElement;
			const l = sel();
			if (t.matches("[data-area]")) {
				area = areas.find((a) => a.id === t.value) ?? area;
				doc = { version: 1, area: area.id, width: area.width, height: area.height, layers: [] };
				selected = null;
				layout();
				void draw();
				return;
			}
			if (t.matches("[data-color-input]") && l) {
				if (l.type === "text") l.color = t.value;
				if (l.type === "shape") l.fill = t.value;
				void draw();
				return;
			}
			const prop = t.dataset.prop;
			if (!prop || !l) return;
			const v = t.value;
			if (l.type === "text") {
				if (prop === "text") l.text = v.slice(0, DESIGN_LIMITS.maxText);
				if (prop === "font") l.font = v;
				if (prop === "align") l.align = v as "left" | "center" | "right";
				if (prop === "weight") l.weight = v as "normal" | "bold";
				if (prop === "size") l.size = Number(v);
			} else if (prop === "w") {
				const r = l.h / l.w;
				l.w = Number(v);
				l.h = Math.round(l.w * r);
			}
			if (prop === "rotation") l.rotation = Number(v);
			if (prop === "text" || prop === "font" || prop === "align" || prop === "weight") {
				// keep focus on the input while redrawing the canvas only
				void draw().then(() => (t as HTMLElement).focus?.());
			} else void draw();
		});
		const upload = root.querySelector<HTMLInputElement>("[data-upload]");
		upload?.addEventListener("change", async () => {
			const file = upload.files?.[0];
			if (!file) return;
			const st = $<HTMLElement>("[data-upload-status]");
			const max = config.uploadMaxBytes ?? 4 * 1024 * 1024;
			if (file.size > max) return (st.textContent = `Max ${Math.round(max / 1024 / 1024)} MB`);
			st.textContent = "Uploading…";
			try {
				const mediaId = await uploadFile(opts.uploadUrl, file, "design-image");
				const url = URL.createObjectURL(file);
				uploads.set(mediaId.mediaId, url);
				await loadImage(url, url);
				const w = Math.round(doc.width * 0.6);
				add({ id: uid(), type: "image", source: { kind: "upload", mediaId: mediaId.mediaId }, x: Math.round((doc.width - w) / 2), y: Math.round(doc.height * 0.15), w, h: w });
				st.textContent = "Added";
			} catch (err) {
				st.textContent = err instanceof Error ? err.message : "Upload failed";
			}
			upload.value = "";
		});

		/* ---- pointer drag ---- */
		let drag: { id: string; dx: number; dy: number } | null = null;
		canvas.addEventListener("pointerdown", (e) => {
			const r = canvas.getBoundingClientRect();
			const px = ((e.clientX - r.left) / r.width) * stage.w;
			const py = ((e.clientY - r.top) / r.height) * stage.h;
			const s = scale();
			const hit = [...doc.layers].reverse().find((l) => {
				const b = bounds(l, s, box.x, box.y);
				return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
			});
			selected = hit?.id ?? selected;
			if (hit) {
				drag = { id: hit.id, dx: px - (box.x + hit.x * s), dy: py - (box.y + hit.y * s) };
				canvas.setPointerCapture(e.pointerId);
			}
			void draw();
		});
		canvas.addEventListener("pointermove", (e) => {
			if (!drag) return;
			const r = canvas.getBoundingClientRect();
			const px = ((e.clientX - r.left) / r.width) * stage.w;
			const py = ((e.clientY - r.top) / r.height) * stage.h;
			const l = doc.layers.find((x) => x.id === drag!.id);
			if (!l) return;
			const s = scale();
			l.x = Math.round(Math.max(-doc.width, Math.min(2 * doc.width, (px - drag.dx - box.x) / s)));
			l.y = Math.round(Math.max(-doc.height, Math.min(2 * doc.height, (py - drag.dy - box.y) / s)));
			void draw();
		});
		canvas.addEventListener("pointerup", () => (drag = null));
		canvas.addEventListener("wheel", (e) => {
			const l = sel();
			if (!l) return;
			e.preventDefault();
			const f = e.deltaY < 0 ? 1.08 : 0.92;
			if (l.type === "text") l.size = Math.max(4, Math.min(DESIGN_LIMITS.maxFontSize, Math.round(l.size * f)));
			else {
				l.w = Math.max(1, Math.min(2 * doc.width, Math.round(l.w * f)));
				l.h = Math.max(1, Math.min(2 * doc.height, Math.round(l.h * f)));
			}
			void draw();
		}, { passive: false });
		document.addEventListener("keydown", onKey);
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") close(null);
		}

		/* ---- save: validate, export preview, upload ---- */
		async function save() {
			const errors = validateDesign(doc, config);
			if (errors.length) return (status.textContent = errors[0]!);
			const saveBtn = $<HTMLButtonElement>("[data-save]");
			saveBtn.disabled = true;
			status.textContent = "Saving design…";
			let previewDataUrl: string | undefined;
			let previewMediaId: string | undefined;
			try {
				const out = document.createElement("canvas");
				const max = 900;
				const s = Math.min(1, max / Math.max(doc.width, doc.height));
				out.width = Math.round(doc.width * s);
				out.height = Math.round(doc.height * s);
				const oc = out.getContext("2d")!;
				oc.fillStyle = doc.background ?? "#ffffff";
				oc.fillRect(0, 0, out.width, out.height);
				const prev = ctx;
				// measureText uses `ctx` — fine, fonts are the same
				void prev;
				drawLayers(oc, s, 0, 0, false);
				previewDataUrl = out.toDataURL("image/png");
				const blob = await new Promise<Blob | null>((r) => out.toBlob(r, "image/png"));
				if (blob) previewMediaId = (await uploadFile(opts.uploadUrl, new File([blob], "design-preview.png", { type: "image/png" }), "design-preview")).mediaId;
			} catch {
				// A cross-origin image tainted the canvas: the design still saves; production uses the SVG export.
				previewDataUrl = undefined;
			}
			close({ design: doc, previewMediaId, previewDataUrl });
		}
		function close(result: StudioResult | null) {
			document.removeEventListener("keydown", onKey);
			root.remove();
			resolve(result);
		}

		// Preload referenced images, then draw.
		layout();
		Promise.all(doc.layers.map((l) => {
			const url = layerImageUrl(l);
			return url ? loadImage(url, url) : Promise.resolve(null);
		})).then(() => draw());
		window.addEventListener("resize", () => {
			layout();
			void draw();
		}, { once: false });
	});
}

async function uploadFile(url: string, file: File, purpose: "design-image" | "design-preview"): Promise<{ mediaId: string; url: string }> {
	const bytes = await new Promise<string>((res, rej) => {
		const fr = new FileReader();
		fr.onload = () => res(String(fr.result));
		fr.onerror = () => rej(new Error("Could not read the file"));
		fr.readAsDataURL(file);
	});
	const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: file.name, contentType: file.type, bytes, purpose }) });
	const body = (await r.json().catch(() => ({}))) as { success?: boolean; data?: { mediaId: string; url: string }; error?: { message?: string } };
	if (!r.ok || !body.data) throw new Error(body.error?.message ?? "Upload failed");
	return body.data;
}
