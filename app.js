const state = { pages: [], ready: false };

function applyTheme(night) {
  document.documentElement.dataset.theme = night ? "night" : "day";
  const input = $("theme");
  if (!input) return;
  input.checked = night;
  $("theme-label").textContent = night ? "夜晚" : "白天";
  localStorage.setItem("slide-theme", night ? "night" : "day");
}
const PAD_SPAN = 0.06;
const WORK_MAX_SIDE = 1400;
const EDITOR_MAX_SIDE = 1100;
const DETECT_MAX_SIDE = 1100;
const $ = (id) => document.getElementById(id);
applyTheme(document.documentElement.dataset.theme === "night");
$("theme").addEventListener("change", () => applyTheme($("theme").checked));
let cv = null;
let engine = null;
let heif = null;

function padRatio() {
  return (Number($("pad").value) - 50) / 50 * PAD_SPAN;
}

function padText() {
  const slider = Number($("pad").value);
  if (slider === 50) return "50% · 标准";
  const amount = Math.abs(padRatio() * 100).toFixed(1).replace(/\.0$/, "");
  return slider < 50 ? `${slider}% · 收紧 ${amount}%` : `${slider}% · 放宽 ${amount}%`;
}

function settings() {
  return {
    aspect: $("aspect").value,
    width: Number($("width").value),
    pad: padRatio(),
  };
}

function baseName() {
  const raw = $("pdf-name").value.trim().replace(/[\\/:*?"<>|]/g, "").replace(/\.(pdf|jpe?g|png)$/i, "").trim();
  return raw || "会议PPT";
}

function pdfName() {
  return `${baseName()}.pdf`;
}

function longImageName() {
  return `${baseName()}.jpg`;
}

function showBusy(title, detail) {
  $("busy").hidden = false;
  $("busy-title").textContent = title;
  $("busy-detail").textContent = detail || "请稍候，不要关闭页面。";
}
function hideBusy() {
  $("busy").hidden = true;
}

function setLamp(stateName, text) {
  const lamp = $("lamp");
  if (!lamp) return;
  lamp.dataset.state = stateName;
  $("lamp-text").textContent = text;
}
function paintFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function isHeic(file, bytes) {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".heic") || name.endsWith(".heif") || /heic|heif/.test(file.type || "")) return true;
  if (!bytes || bytes.length < 12) return false;
  const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  return ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand);
}

async function canvasFromHeic(bytes) {
  if (!heif) throw new Error("这台浏览器还不能解码 HEIC");
  const decoder = new heif.HeifDecoder();
  const images = decoder.decode(bytes);
  if (!images || !images.length) throw new Error("HEIC 里没有图像");
  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();
  const data = new ImageData(width, height);
  await new Promise((resolve, reject) => {
    image.display(data, (shown) => (shown ? resolve(shown) : reject(new Error("HEIC 解码失败"))));
  });
  if (image.free) image.free();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").putImageData(data, 0, 0);
  return canvas;
}

function drawScaled(source, maxSide) {
  const sw = source.width;
  const sh = source.height;
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = dw;
  canvas.height = dh;
  canvas.getContext("2d").drawImage(source, 0, 0, dw, dh);
  return canvas;
}

async function blobToCanvas(blob) {
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    return canvas;
  } finally {
    bitmap.close();
  }
}

async function loadPageMedia(file) {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (isHeic(file, head)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const full = await canvasFromHeic(bytes);
    try {
      const width = full.width;
      const height = full.height;
      const work = Math.max(width, height) > WORK_MAX_SIDE ? drawScaled(full, WORK_MAX_SIDE) : drawScaled(full, Math.max(width, height));
      let blob = null;
      if (work.width < width || work.height < height) {
        blob = await new Promise((resolve) => full.toBlob(resolve, "image/jpeg", 0.94));
      }
      return { width, height, work, blob };
    } finally {
      full.width = full.height = 0;
    }
  }
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const width = bitmap.width;
    const height = bitmap.height;
    const work = drawScaled(bitmap, WORK_MAX_SIDE);
    const blob = work.width < width || work.height < height ? file : null;
    return { width, height, work, blob };
  } finally {
    bitmap.close();
  }
}

function canvasToRgbaMat(canvas) {
  const image = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  return cv.matFromArray(canvas.height, canvas.width, cv.CV_8UC4, image.data);
}

function rgbaMatToCanvas(mat) {
  const canvas = document.createElement("canvas");
  canvas.width = mat.cols;
  canvas.height = mat.rows;
  const copy = new Uint8ClampedArray(mat.data);
  canvas.getContext("2d").putImageData(new ImageData(copy, mat.cols, mat.rows), 0, 0);
  return canvas;
}

function detectFromWork(work, fullW, fullH) {
  const small = Math.max(work.width, work.height) > DETECT_MAX_SIDE ? drawScaled(work, DETECT_MAX_SIDE) : work;
  const rgba = canvasToRgbaMat(small);
  try {
    const found = engine.detectQuad(rgba);
    const sx = fullW / small.width;
    const sy = fullH / small.height;
    const corners = engine.orderPoints(found.corners.map((p) => [
      Math.max(0, Math.min(fullW - 1, p[0] * sx)),
      Math.max(0, Math.min(fullH - 1, p[1] * sy)),
    ]));
    return { corners, confidence: found.confidence };
  } finally {
    rgba.delete();
    if (small !== work) small.width = small.height = 0;
  }
}

function warpFromCanvas(sourceCanvas, corners, outW) {
  const rgba = canvasToRgbaMat(sourceCanvas);
  try {
    const warped = engine.warpSlide(rgba, corners, settings().aspect, outW, settings().pad);
    try {
      return rgbaMatToCanvas(warped);
    } finally {
      warped.delete();
    }
  } finally {
    rgba.delete();
  }
}

function warpPreviewCanvas(page, outW) {
  const sx = page.work.width / page.width;
  const sy = page.work.height / page.height;
  const scaled = page.corners.map((p) => [p[0] * sx, p[1] * sy]);
  return warpFromCanvas(page.work, scaled, outW);
}

async function warpFullCanvas(page, outW) {
  if (!page.blob || (page.work.width >= page.width && page.work.height >= page.height)) {
    return warpPreviewCanvas(page, outW);
  }
  const full = await blobToCanvas(page.blob);
  try {
    return warpFromCanvas(full, page.corners, outW);
  } finally {
    full.width = full.height = 0;
  }
}

async function canvasJpeg(canvas, quality) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new Error("JPEG 编码失败");
  return new Uint8Array(await blob.arrayBuffer());
}

function concatBytes(parts) {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function imagesToPdf(pages) {
  const text = new TextEncoder();
  const b = (value) => text.encode(value);
  const pageWidth = 792;
  const objects = [];
  const add = (data) => {
    objects.push(data);
    return objects.length;
  };
  const contentIds = [];
  const imageIds = [];
  const sizes = pages.map((page) => [pageWidth, pageWidth * page.height / page.width]);
  pages.forEach((page, index) => {
    const [pageW, pageH] = sizes[index];
    const content = b(`q ${pageW.toFixed(2)} 0 0 ${pageH.toFixed(2)} 0 0 cm /Im0 Do Q`);
    contentIds.push(add(concatBytes([
      b(`<< /Length ${content.length} >>\nstream\n`),
      content,
      b("\nendstream"),
    ])));
    imageIds.push(add(concatBytes([
      b(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`),
      page.jpeg,
      b("\nendstream"),
    ])));
  });
  const pagesId = add(b(""));
  const catalogId = add(b(""));
  const pageIds = pages.map((page, index) => add(b(
    `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${sizes[index][0].toFixed(2)} ${sizes[index][1].toFixed(2)}] /Resources << /XObject << /Im0 ${imageIds[index]} 0 R >> >> /Contents ${contentIds[index]} 0 R >>`,
  )));
  const kids = pageIds.map((id) => `${id} 0 R`).join(" ");
  objects[pagesId - 1] = b(`<< /Type /Pages /Count ${pageIds.length} /Kids [${kids}] >>`);
  objects[catalogId - 1] = b(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  const chunks = [b("%PDF-1.4\n"), new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])];
  const offsets = [0];
  let length = chunks[0].length + chunks[1].length;
  objects.forEach((obj, index) => {
    offsets.push(length);
    const head = b(`${index + 1} 0 obj\n`);
    const tail = b("\nendobj\n");
    chunks.push(head, obj, tail);
    length += head.length + obj.length + tail.length;
  });
  const xrefAt = length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  chunks.push(b(xref));
  return concatBytes(chunks);
}

let padTimer = 0;
$("pad").addEventListener("input", () => {
  $("pad-label").textContent = padText();
  clearTimeout(padTimer);
  padTimer = setTimeout(refreshAllPreviews, 180);
});
$("aspect").addEventListener("change", refreshAllPreviews);
$("width").addEventListener("change", refreshAllPreviews);

const drop = $("drop");
drop.addEventListener("dragover", (ev) => { ev.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (ev) => {
  ev.preventDefault();
  drop.classList.remove("over");
  addFiles(ev.dataTransfer.files);
});
$("pick").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", () => { addFiles($("file").files); $("file").value = ""; });

async function addFiles(fileList) {
  const files = [...fileList].filter(Boolean);
  if (!files.length) return;
  if (!state.ready) {
    $("status").textContent = state.bootError || "识别库还在加载，请稍候再选照片。";
    return;
  }
  showBusy(`正在处理 ${files.length} 张照片`, "请稍候，不要关闭页面。");
  setLamp("upload", "正在读取照片");
  await paintFrame();
  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setLamp("upload", "正在读取照片");
      showBusy(`正在读取第 ${i + 1} / ${files.length} 张`, file.name);
      await paintFrame();
      const media = await loadPageMedia(file);
      setLamp("compute", "正在计算");
      showBusy(`正在识别第 ${i + 1} / ${files.length} 张`, file.name);
      await paintFrame();
      const found = detectFromWork(media.work, media.width, media.height);
      state.pages.push({
        id: `${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name || `照片 ${state.pages.length + 1}`,
        width: media.width,
        height: media.height,
        work: media.work,
        blob: media.blob,
        corners: found.corners,
        confidence: found.confidence,
      });
    }
    $("status").textContent = "识别完成。先看每一页的预览，不合适再改红框或松紧。";
    render();
  } catch (err) {
    $("status").textContent = err.message || String(err);
    render();
  } finally {
    hideBusy();
    if (state.ready) setLamp("ready", "就绪");
  }
}

function render() {
  const list = $("pages");
  list.innerHTML = "";
  state.pages.forEach((page, index) => list.appendChild(card(page, index)));
  $("export-bar").hidden = state.pages.length === 0;
  $("order-bar").hidden = state.pages.length < 2;
  $("count").textContent = state.pages.length ? `共 ${state.pages.length} 页，按当前上下顺序装订。` : "";
}

function card(page, index) {
  const node = document.createElement("article");
  node.className = "card";
  const head = document.createElement("div");
  head.className = "card-head";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = `第 ${index + 1} 页 · ${page.name}`;
  const tools = document.createElement("div");
  tools.className = "tools";
  tools.append(
    action("上移", index === 0, () => move(index, -1)),
    action("下移", index === state.pages.length - 1, () => move(index, 1)),
    action("重新识别", false, () => redetect(page)),
    action("删除", false, () => remove(index)),
  );
  head.append(name, tools);
  const layout = document.createElement("div");
  layout.className = "layout";
  const canvas = document.createElement("canvas");
  const preview = document.createElement("img");
  preview.className = "result";
  preview.alt = "拉正后的预览";
  preview.title = "单击放大检查";
  preview.addEventListener("click", () => openDetail(page));
  layout.append(
    column("原图。拖圆点改角，拖边线中部可平移整条边。", canvas),
    column("预览。单击图片可放大检查。这就是写进 PDF 的这一页。", preview),
  );
  node.append(head, layout);
  if (page.confidence < 0.35) {
    const warn = document.createElement("div");
    warn.className = "warn";
    warn.textContent = "这张自动识别不太可靠。请把四个圆点分别拖到幻灯片的四个角上，再看右边是否端正。";
    node.append(warn);
  }
  page.previewEl = preview;
  mountEditor(canvas, page);
  refreshPreview(page);
  return node;
}

function column(caption, child) {
  const wrap = document.createElement("div");
  wrap.className = "col";
  const cap = document.createElement("div");
  cap.className = "cap";
  cap.textContent = caption;
  wrap.append(cap, child);
  return wrap;
}

function action(label, disabled, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

function reversePages() {
  if (state.pages.length < 2) return;
  state.pages.reverse();
  render();
  $("status").textContent = "已翻转全部页面。若相册是新的在前，现在就是按拍摄先后排列。";
}
$("reverse").addEventListener("click", reversePages);

function move(index, delta) {
  const next = index + delta;
  if (next < 0 || next >= state.pages.length) return;
  const [item] = state.pages.splice(index, 1);
  state.pages.splice(next, 0, item);
  render();
}

function disposePage(page) {
  if (!page) return;
  if (page.previewUrl) URL.revokeObjectURL(page.previewUrl);
  if (page.work) {
    page.work.width = page.work.height = 0;
    page.work = null;
  }
  page.blob = null;
}

function remove(index) {
  const [page] = state.pages.splice(index, 1);
  disposePage(page);
  render();
}

function clearPages() {
  if (!$("busy").hidden) return;
  closeDetail();
  for (const page of state.pages) disposePage(page);
  state.pages = [];
  render();
  $("status").textContent = "已清空全部照片，可以继续放入下一批。";
}
$("clear").addEventListener("click", clearPages);

async function redetect(page) {
  showBusy("正在重新识别这一张", page.name);
  setLamp("compute", "正在计算");
  await paintFrame();
  try {
    const found = detectFromWork(page.work, page.width, page.height);
    page.corners = found.corners;
    page.confidence = found.confidence;
    $("status").textContent = "";
    render();
  } catch (err) {
    $("status").textContent = err.message || String(err);
  } finally {
    hideBusy();
    if (state.ready) setLamp("ready", "就绪");
  }
}

function mountEditor(canvas, page) {
  const ctx = canvas.getContext("2d");
  const src = page.work;
  let drag = null;
  let lastFull = null;
  const edScale = Math.min(1, EDITOR_MAX_SIDE / Math.max(src.width, src.height));
  canvas.width = Math.max(1, Math.round(src.width * edScale));
  canvas.height = Math.max(1, Math.round(src.height * edScale));
  // 第一次绘制发生在卡片插入页面前，此时还没有排版宽度，手柄会被算成 1 像素级。
  // 等进入页面并完成布局后再画，圆点和边框手柄才是屏幕上的固定大小。
  requestAnimationFrame(() => {
    if (!canvas.isConnected) return;
    if (canvas.getBoundingClientRect().width <= 0) {
      requestAnimationFrame(() => page.redraw && page.redraw());
      return;
    }
    draw();
  });

  function displayPoint(corner) {
    return [corner[0] * canvas.width / page.width, corner[1] * canvas.height / page.height];
  }
  function eventToFull(ev) {
    const rect = canvas.getBoundingClientRect();
    const x = (ev.clientX - rect.left) * canvas.width / rect.width;
    const y = (ev.clientY - rect.top) * canvas.height / rect.height;
    return [x * page.width / canvas.width, y * page.height / canvas.height];
  }
  function cssScale() {
    const rect = canvas.getBoundingClientRect();
    return rect.width > 0 ? canvas.width / rect.width : 1;
  }
  function draw() {
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    const pts = page.corners.map(displayPoint);
    const px = cssScale();
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.lineWidth = 2.5 * px;
    ctx.strokeStyle = "#ff3b30";
    ctx.stroke();
    const radius = (window.matchMedia("(pointer: coarse)").matches ? 16 : 11) * px;
    pts.forEach((p, i) => {
      const q = pts[(i + 1) % 4];
      const mx = (p[0] + q[0]) / 2;
      const my = (p[1] + q[1]) / 2;
      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(Math.atan2(q[1] - p[1], q[0] - p[0]));
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#1d4e89";
      ctx.lineWidth = 2 * px;
      ctx.fillRect(-16 * px, -5 * px, 32 * px, 10 * px);
      ctx.strokeRect(-16 * px, -5 * px, 32 * px, 10 * px);
      ctx.restore();
    });
    pts.forEach((p) => {
      ctx.beginPath();
      ctx.arc(p[0], p[1], radius, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.lineWidth = Math.max(2, radius / 4);
      ctx.strokeStyle = "#1d4e89";
      ctx.stroke();
    });
  }
  function clampPoint(x, y) {
    return [
      Math.min(page.width * 1.05, Math.max(-page.width * 0.05, x)),
      Math.min(page.height * 1.05, Math.max(-page.height * 0.05, y)),
    ];
  }
  function updateLoupe(ev, point) {
    if (!drag) return;
    const loupe = ensureLoupe();
    const zoom = 3.2;
    const ctxL = loupe.canvas.getContext("2d");
    const size = loupe.canvas.width;
    const srcSize = size / zoom;
    const iw = src.width;
    const ih = src.height;
    let sx = point[0] - srcSize / 2;
    let sy = point[1] - srcSize / 2;
    let sw = srcSize;
    let sh = srcSize;
    let dx = 0;
    let dy = 0;
    let dw = size;
    let dh = size;
    if (sx < 0) { dx += -sx / srcSize * size; dw -= -sx / srcSize * size; sw += sx; sx = 0; }
    if (sy < 0) { dy += -sy / srcSize * size; dh -= -sy / srcSize * size; sh += sy; sy = 0; }
    if (sx + sw > iw) { const over = sx + sw - iw; dw -= over / srcSize * size; sw -= over; }
    if (sy + sh > ih) { const over = sy + sh - ih; dh -= over / srcSize * size; sh -= over; }
    ctxL.fillStyle = "#111";
    ctxL.fillRect(0, 0, size, size);
    if (sw > 1 && sh > 1 && dw > 1 && dh > 1) ctxL.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
    const cx = sw > 1 ? dx + (point[0] - sx) / sw * dw : size / 2;
    const cy = sh > 1 ? dy + (point[1] - sy) / sh * dh : size / 2;
    ctxL.strokeStyle = "#ff3b30";
    ctxL.lineWidth = 3;
    ctxL.beginPath();
    ctxL.moveTo(cx - 22, cy);
    ctxL.lineTo(cx + 22, cy);
    ctxL.moveTo(cx, cy - 22);
    ctxL.lineTo(cx, cy + 22);
    ctxL.stroke();
    loupe.hidden = false;
    const box = loupe.offsetWidth || 156;
    const gap = 28;
    let left = ev.clientX - box / 2;
    let top = ev.clientY - box - gap - 36;
    if (top < 8) top = Math.min(window.innerHeight - box - 8, ev.clientY + gap + 48);
    left = Math.max(8, Math.min(left, window.innerWidth - box - 8));
    loupe.style.left = `${left}px`;
    loupe.style.top = `${top}px`;
  }
  canvas.addEventListener("pointerdown", (ev) => {
    const [x, y] = eventToFull(ev);
    const rect = canvas.getBoundingClientRect();
    const finger = window.matchMedia("(pointer: coarse)").matches ? 36 : 22;
    const limit = finger * page.width / Math.max(rect.width, 1);
    let best = -1;
    let bestDist = limit;
    page.corners.forEach((corner, i) => {
      const dist = Math.hypot(corner[0] - x, corner[1] - y);
      if (dist < bestDist) { best = i; bestDist = dist; }
    });
    let edge = -1;
    if (best < 0) {
      let edgeDist = limit;
      for (let i = 0; i < 4; i++) {
        const a = page.corners[i];
        const b = page.corners[(i + 1) % 4];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len2 = dx * dx + dy * dy || 1;
        let t = ((x - a[0]) * dx + (y - a[1]) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const dist = Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
        if (dist < edgeDist && t > 0.12 && t < 0.88) { edge = i; edgeDist = dist; }
      }
    }
    if (best < 0 && edge < 0) return;
    drag = best >= 0 ? { kind: "corner", index: best } : { kind: "edge", index: edge };
    lastFull = [x, y];
    canvas.setPointerCapture(ev.pointerId);
    const focus = drag.kind === "corner" ? page.corners[drag.index] : [x, y];
    updateLoupe(ev, [focus[0] * src.width / page.width, focus[1] * src.height / page.height]);
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const [x, y] = eventToFull(ev);
    const dx = x - lastFull[0];
    const dy = y - lastFull[1];
    lastFull = [x, y];
    if (drag.kind === "corner") page.corners[drag.index] = clampPoint(x, y);
    else {
      const i = drag.index;
      const j = (i + 1) % 4;
      page.corners[i] = clampPoint(page.corners[i][0] + dx, page.corners[i][1] + dy);
      page.corners[j] = clampPoint(page.corners[j][0] + dx, page.corners[j][1] + dy);
    }
    draw();
    const focus = drag.kind === "corner" ? page.corners[drag.index] : [x, y];
    updateLoupe(ev, [focus[0] * src.width / page.width, focus[1] * src.height / page.height]);
  });
  function endDrag() {
    if (!drag) return;
    drag = null;
    hideLoupe();
    refreshPreview(page);
  }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  page.redraw = draw;
}

async function refreshPreview(page) {
  const mine = page.token = (page.token || 0) + 1;
  let preview = null;
  try {
    preview = warpPreviewCanvas(page, Math.min(settings().width, 960));
    const blob = await new Promise((resolve) => preview.toBlob(resolve, "image/jpeg", 0.84));
    if (mine !== page.token) return;
    if (page.previewUrl) URL.revokeObjectURL(page.previewUrl);
    page.previewUrl = URL.createObjectURL(blob);
    if (page.previewEl) page.previewEl.src = page.previewUrl;
  } catch (err) {
    if (mine !== page.token) return;
    $("status").textContent = err.message || String(err);
  } finally {
    if (preview) preview.width = preview.height = 0;
  }
}

function ensureLoupe() {
  let el = $("loupe");
  if (!el) {
    el = document.createElement("div");
    el.id = "loupe";
    el.hidden = true;
    const canvas = document.createElement("canvas");
    canvas.width = 360;
    canvas.height = 360;
    el.append(canvas);
    document.body.append(el);
    el.canvas = canvas;
  }
  return el;
}
function hideLoupe() {
  const el = $("loupe");
  if (el) el.hidden = true;
}

let previewBatch = 0;
async function refreshAllPreviews() {
  const mine = ++previewBatch;
  for (let i = 0; i < state.pages.length; i++) {
    if (mine !== previewBatch) return;
    await refreshPreview(state.pages[i]);
    if (i % 2 === 1) await paintFrame();
  }
}

let detailUrl = "";
function ensureLightbox() {
  if ($("lightbox")) return;
  const box = document.createElement("div");
  box.id = "lightbox";
  box.hidden = true;
  const close = document.createElement("button");
  close.id = "lightbox-close";
  close.type = "button";
  close.textContent = "关闭";
  const caption = document.createElement("p");
  caption.id = "lightbox-cap";
  const image = document.createElement("img");
  image.id = "lightbox-img";
  image.alt = "放大后的预览";
  box.append(close, caption, image);
  document.body.append(box);
  box.addEventListener("click", (ev) => { if (ev.target === box) closeDetail(); });
  close.addEventListener("click", closeDetail);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !$("lightbox").hidden) closeDetail();
  });
}
async function openDetail(page) {
  ensureLightbox();
  const box = $("lightbox");
  box.hidden = false;
  $("lightbox-cap").textContent = "正在生成大图…";
  $("lightbox-img").removeAttribute("src");
  let full = null;
  try {
    full = await warpFullCanvas(page, settings().width);
    const blob = await new Promise((resolve) => full.toBlob(resolve, "image/jpeg", 0.9));
    if (detailUrl) URL.revokeObjectURL(detailUrl);
    detailUrl = URL.createObjectURL(blob);
    $("lightbox-img").src = detailUrl;
    $("lightbox-cap").textContent = "单击空白处或按 Esc 关闭";
  } catch (err) {
    $("lightbox-cap").textContent = err.message || "大图生成失败";
  } finally {
    if (full) full.width = full.height = 0;
  }
}
function closeDetail() {
  const box = $("lightbox");
  if (!box || box.hidden) return;
  box.hidden = true;
  $("lightbox-img").removeAttribute("src");
  if (detailUrl) URL.revokeObjectURL(detailUrl);
  detailUrl = "";
}

window.addEventListener("resize", () => {
  state.pages.forEach((page) => page.redraw && page.redraw());
});

let saveUrl = "";
function setExportDisabled(disabled) {
  $("export").disabled = disabled;
  $("export-long").disabled = disabled;
  $("clear").disabled = disabled;
}

function deliverDownload(blob, filename, kind, extraNote) {
  const url = URL.createObjectURL(blob);
  if (isAppleTouch()) {
    if (saveUrl) URL.revokeObjectURL(saveUrl);
    saveUrl = url;
    const isImage = kind === "image";
    $("save-title").textContent = isImage ? "长图已生成" : "PDF 已生成";
    $("save-pdf-help").textContent = isImage
      ? "点下面的链接打开或下载。iPhone 若直接显示图片，长按图片即可“存储到照片”。"
      : "点下面的链接下载。若 Safari 直接打开了预览，再点屏幕下方的分享按钮，选择“存储到文件”。";
    const link = $("save-pdf-link");
    link.href = url;
    link.download = filename;
    link.textContent = `下载 ${filename}`;
    $("save-pdf-name").textContent = filename;
    $("save-pdf").hidden = false;
    $("status").textContent = `${isImage ? "长图" : "PDF"}已生成。请点弹出的下载链接。${extraNote || ""}`;
  } else {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    $("status").textContent = `已开始下载 ${filename}${extraNote || ""}`;
  }
}

function stitchPages(canvases, maxArea, maxHeight) {
  const count = canvases.length;
  const maxW = Math.max(...canvases.map((c) => c.width));
  const gap = count > 1 ? Math.max(8, Math.round(maxW * 0.012)) : 0;
  const pad = gap;
  const rawW = maxW + pad * 2;
  const rawH = canvases.reduce((sum, c) => sum + c.height, 0) + gap * Math.max(0, count - 1) + pad * 2;
  let scale = 1;
  if (rawH > maxHeight) scale = Math.min(scale, maxHeight / rawH);
  if (rawW * rawH * scale * scale > maxArea) scale = Math.min(scale, Math.sqrt(maxArea / (rawW * rawH)));
  const outW = Math.max(1, Math.floor(rawW * scale));
  const outH = Math.max(1, Math.floor(rawH * scale));
  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("浏览器画布尺寸受限，无法拼接这么多页");
  ctx.fillStyle = "#e8e8e8";
  ctx.fillRect(0, 0, outW, outH);
  let y = pad * scale;
  for (const c of canvases) {
    const dw = c.width * scale;
    const dh = c.height * scale;
    const dx = (outW - dw) / 2;
    ctx.drawImage(c, dx, y, dw, dh);
    y += dh + gap * scale;
  }
  return out;
}

$("export").addEventListener("click", async () => {
  if (!state.pages.length) return;
  const filename = pdfName();
  setExportDisabled(true);
  showBusy("正在生成 PDF", filename);
  setLamp("compute", "正在计算");
  await paintFrame();
  try {
    const encoded = [];
    for (let i = 0; i < state.pages.length; i++) {
      const page = state.pages[i];
      showBusy(`正在生成第 ${i + 1} / ${state.pages.length} 页`, page.name);
      await paintFrame();
      const full = await warpFullCanvas(page, settings().width);
      encoded.push({
        jpeg: await canvasJpeg(full, 0.9),
        width: full.width,
        height: full.height,
      });
      full.width = full.height = 0;
    }
    const pdf = imagesToPdf(encoded);
    const blob = new Blob([pdf], { type: "application/pdf" });
    deliverDownload(blob, filename, "pdf");
  } catch (err) {
    $("status").textContent = err.message || String(err);
  } finally {
    setExportDisabled(false);
    hideBusy();
    if (state.ready) setLamp("ready", "就绪");
  }
});

$("export-long").addEventListener("click", async () => {
  if (!state.pages.length) return;
  const filename = longImageName();
  setExportDisabled(true);
  showBusy("正在拼接长图", filename);
  setLamp("compute", "正在计算");
  await paintFrame();
  const warped = [];
  let stitched = null;
  try {
    const mobile = isAppleTouch();
    const maxArea = mobile ? 16000000 : 120000000;
    const maxHeight = mobile ? 16000 : 30000;
    const estW = Math.floor(Math.sqrt(maxArea / (state.pages.length * 0.62)));
    const warpW = Math.min(settings().width, Math.max(640, estW));
    for (let i = 0; i < state.pages.length; i++) {
      const page = state.pages[i];
      showBusy(`正在处理第 ${i + 1} / ${state.pages.length} 页`, page.name);
      await paintFrame();
      warped.push(await warpFullCanvas(page, warpW));
    }
    showBusy("正在拼接并编码长图", filename);
    await paintFrame();
    stitched = stitchPages(warped, maxArea, maxHeight);
    const dims = `${stitched.width}×${stitched.height}`;
    for (const c of warped) c.width = c.height = 0;
    warped.length = 0;
    const blob = await new Promise((resolve) => stitched.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) throw new Error("长图编码失败，请尝试降低清晰度或减少页数");
    deliverDownload(blob, filename, "image", `（${dims}）`);
  } catch (err) {
    $("status").textContent = err.message || String(err);
  } finally {
    for (const c of warped) c.width = c.height = 0;
    if (stitched) stitched.width = stitched.height = 0;
    setExportDisabled(false);
    hideBusy();
    if (state.ready) setLamp("ready", "就绪");
  }
});

function isAppleTouch() {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function closeSavePdf() {
  $("save-pdf").hidden = true;
}
$("save-pdf-close").addEventListener("click", closeSavePdf);

async function boot() {
  setLamp("load", "正在加载计算脚本");
  $("status").textContent = "正在加载识别库…";
  try {
    let lib = window.cv;
    if (lib && typeof lib.then === "function") lib = await lib;
    if (lib && typeof lib.then === "function") lib = await lib;
    cv = lib;
    if (typeof cv.Mat !== "function") throw new Error("OpenCV 没有准备好");
    engine = SlideLocal.create(cv);
    if (typeof libheif === "function") {
      const wasm = await fetch("vendor/libheif.wasm");
      if (!wasm.ok) throw new Error("HEIC 解码库没有加载到");
      heif = await libheif({ wasmBinary: await wasm.arrayBuffer() });
    }
    state.ready = true;
    setLamp("ready", "就绪");
    $("status").textContent = "可以把照片放进来。照片只在这个浏览器里处理，不会上传。";
  } catch (err) {
    state.bootError = `识别库加载失败：${err.message || err}`;
    setLamp("load", "计算脚本加载失败");
    $("status").textContent = state.bootError;
  }
}
boot();
