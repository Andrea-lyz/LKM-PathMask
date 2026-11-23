(() => {
	"use strict";

	// Optional Android WebUI edge-to-edge support; the browser preview has no bridge.
	try {
		if (typeof window.ksu?.fullScreen === "function") window.ksu.fullScreen(true);
	} catch (_) {}

	const isChromium = /(?:Chrome|Chromium)\/\d+/.test(navigator.userAgent) && !/Firefox/.test(navigator.userAgent);
	const svgBackdrop = isChromium && window.CSS?.supports("backdrop-filter", "url(#liquid-glass)");
	if (!svgBackdrop) document.documentElement.classList.add("no-svg-backdrop");

	const params = Object.freeze({ scale: 70, bezel: 18, chroma: 6, blur: 4, sat: 1.5 });
	const svgNS = "http://www.w3.org/2000/svg";
	let defs;

	function svgNode(name, attrs, parent) {
		const el = document.createElementNS(svgNS, name);
		for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
		parent?.append(el);
		return el;
	}

	function createFilter(id) {
		if (!defs) {
			const svg = svgNode("svg", { class: "liquidGlassDefs", width: 0, height: 0, "aria-hidden": "true" }, document.body);
			defs = svgNode("defs", {}, svg);
		}
		const filter = svgNode("filter", { id, "color-interpolation-filters": "sRGB" }, defs);
		const map = svgNode("feImage", { x: 0, y: 0, width: 1, height: 1, preserveAspectRatio: "none", result: "map" }, filter);
		svgNode("feGaussianBlur", { in: "SourceGraphic", stdDeviation: params.blur, result: "src" }, filter);
		const channels = [
			["r", params.scale + params.chroma, "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"],
			["g", params.scale, "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"],
			["b", params.scale - params.chroma, "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"],
		];
		for (const [channel, scale, values] of channels) {
			const displaced = "d" + channel;
			svgNode("feDisplacementMap", {
				in: "src", in2: "map", scale, xChannelSelector: "R", yChannelSelector: "G", result: displaced,
			}, filter);
			svgNode("feColorMatrix", { in: displaced, type: "matrix", values, result: channel }, filter);
		}
		svgNode("feBlend", { in: "r", in2: "g", mode: "screen", result: "rg" }, filter);
		svgNode("feBlend", { in: "rg", in2: "b", mode: "screen", result: "rgb" }, filter);
		svgNode("feColorMatrix", { in: "rgb", type: "saturate", values: params.sat }, filter);
		return map;
	}

	// Rounded-rectangle SDF, matching the reference's inward R/G displacement.
	function buildMap(w, h, r, bezel) {
		const canvas = document.createElement("canvas");
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		const img = ctx.createImageData(w, h);
		const d = img.data;
		const hw = w / 2, hh = h / 2;
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const px = x + .5 - hw, py = y + .5 - hh;
				const qx = Math.abs(px) - (hw - r), qy = Math.abs(py) - (hh - r);
				let sd, nx, ny;
				if (qx > 0 && qy > 0) {
					const length = Math.hypot(qx, qy);
					sd = length - r;
					nx = qx / length * Math.sign(px);
					ny = qy / length * Math.sign(py);
				} else if (qx > qy) {
					sd = qx - r;
					nx = Math.sign(px);
					ny = 0;
				} else {
					sd = qy - r;
					nx = 0;
					ny = Math.sign(py);
				}
				const inside = -sd;
				const m = inside > 0 && inside < bezel ? Math.pow(1 - inside / bezel, 2) : 0;
				const i = (y * w + x) * 4;
				d[i] = 128 - 127 * nx * m;
				d[i + 1] = 128 - 127 * ny * m;
				d[i + 2] = 128;
				d[i + 3] = 255;
			}
		}
		ctx.putImageData(img, 0, 0);
		return canvas.toDataURL();
	}

	function watchSize(el, refresh) {
		if (typeof ResizeObserver === "function") new ResizeObserver(refresh).observe(el);
		else window.addEventListener("resize", refresh);
		refresh();
	}

	function mountSurface(el, id) {
		if (!el || !svgBackdrop) return;
		const map = createFilter(id);
		let size = "";
		let redrawFrame = 0;
		el.style.setProperty("--surface-filter", "url(#" + id + ")");
		watchSize(el, () => {
			if (document.documentElement.classList.contains("no-svg-backdrop")) return;
			const w = el.offsetWidth, h = el.offsetHeight;
			if (!w || !h) return;
			const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius);
			const r = Math.min(w / 2, h / 2, Number.isFinite(radius) ? radius : h / 2);
			const nextSize = [w, h, r].join(":");
			if (nextSize === size) return;
			let href;
			try { href = buildMap(w, h, r, params.bezel); } catch (_) {}
			if (!href || href === "data:,") {
				document.documentElement.classList.add("no-svg-backdrop");
				return;
			}
			size = nextSize;
			map.setAttribute("width", w);
			map.setAttribute("height", h);
			map.setAttribute("href", href);
			// Some WebViews keep the old compositor effect after an SVG update.
			cancelAnimationFrame(redrawFrame);
			el.style.backdropFilter = "none";
			redrawFrame = requestAnimationFrame(() => el.style.removeProperty("backdrop-filter"));
		});
	}

	function mountDock(dock) {
		if (!dock) return null;
		const pill = document.createElement("span");
		pill.className = "liquidPill";
		pill.setAttribute("aria-hidden", "true");
		dock.prepend(pill);
		mountSurface(dock, "liquid-glass");

		const items = () => [...dock.querySelectorAll(".liquidDockItem")];
		let pointer = null;
		let lastX = 0;
		let width = 0;
		let pad = 0;
		const px = (name, value) => pill.style.setProperty(name, value + "px");
		const clamp = (value, max) => Math.max(0, Math.min(value, max));

		function indexAt(clientX, total) {
			return width > 0 ? clamp(Math.floor((clientX - dock.getBoundingClientRect().left - pad) / width), total - 1) : 0;
		}

		function followFinger(clientX) {
			lastX = clientX;
			const buttons = items();
			const rel = clientX - dock.getBoundingClientRect().left - pad - width / 2;
			px("--x", clamp(rel, width * (buttons.length - 1)));
			const at = indexAt(clientX, buttons.length);
			buttons.forEach((button, i) => button.classList.toggle("dragCandidate", i === at));
		}

		function sync() {
			const buttons = items();
			if (!buttons.length) return;
			pad = parseFloat(getComputedStyle(dock).paddingLeft) || 0;
			width = Math.max(0, (dock.clientWidth - pad * 2) / buttons.length);
			px("--w", width);
			if (pointer !== null) followFinger(lastX);
			else px("--x", Math.max(0, buttons.findIndex(button => button.getAttribute("aria-current") === "page")) * width);
		}

		watchSize(dock, sync);
		dock.addEventListener("click", event => {
			const button = event.target.closest?.(".liquidDockItem");
			if (button && button.getAttribute("aria-current") !== "page") {
				try { navigator.vibrate?.(8); } catch (_) {}
			}
		}, true);

		if (typeof dock.setPointerCapture === "function") {
			dock.classList.add("liquidDrag");
			dock.addEventListener("pointerdown", event => {
				if (pointer !== null || event.button !== 0 || event.isPrimary === false) return;
				dock.setPointerCapture(event.pointerId);
				pointer = event.pointerId;
				dock.classList.add("isDragging");
				pill.classList.add("dragging");
				pill.style.setProperty("--s", "1.12");
				followFinger(event.clientX);
			});
			dock.addEventListener("pointermove", event => {
				if (event.pointerId === pointer) followFinger(event.clientX);
			});
			const end = event => {
				if (event.pointerId !== pointer) return;
				pointer = null;
				const buttons = items();
				dock.classList.remove("isDragging");
				pill.classList.remove("dragging");
				pill.style.setProperty("--s", "1");
				buttons.forEach(button => button.classList.remove("dragCandidate"));
				if (event.type === "pointerup") {
					const at = indexAt(event.clientX, buttons.length);
					px("--x", at * width);
					// Activate the real button/link, rather than maintaining a parallel route.
					buttons[at]?.click();
				} else sync();
			};
			dock.addEventListener("pointerup", end);
			dock.addEventListener("pointercancel", end);
			dock.addEventListener("lostpointercapture", end);
		}
		return { sync };
	}

	window.PathMaskGlass = { mountDock, mountSurface };
})();
