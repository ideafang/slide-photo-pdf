"""Local web app: upload slide photos, adjust corners, download one PDF."""

from __future__ import annotations

import argparse
import json
import os
import re
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

import numpy as np

import detect

INDEX = Path(__file__).with_name("index.html")
MAX_BODY = 250 * 1024 * 1024
MAX_PAGES = 30
ALLOWED = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".bmp", ".tif", ".tiff"}

_lock = threading.Lock()
_sessions: dict[str, dict] = {}
_downloads: dict[str, dict] = {}


def _new_session() -> str:
    session_id = uuid.uuid4().hex
    with _lock:
        _sessions[session_id] = {"pages": {}}
    return session_id


def _drop_session(session_id: str) -> None:
    with _lock:
        _sessions.pop(session_id, None)


def _remember_pdf(data: bytes, filename: str) -> str:
    now = time.time()
    with _lock:
        expired = [key for key, item in _downloads.items() if now - item["created"] > 600]
        for key in expired:
            _downloads.pop(key, None)
        token = uuid.uuid4().hex
        _downloads[token] = {"data": data, "filename": filename, "created": now}
    return token


def _session(session_id: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{32}", session_id or ""):
        raise KeyError("无效的会话")
    with _lock:
        session = _sessions.get(session_id)
    if session is None:
        raise KeyError("会话已失效，请重新上传")
    return session


def _parse_multipart(content_type: str, body: bytes) -> tuple[dict[str, str], list[tuple[str, bytes]]]:
    match = re.search(r"boundary=([^;]+)", content_type, re.I)
    if not match:
        raise ValueError("上传格式不正确")
    boundary = match.group(1).strip().strip('"')
    marker = b"--" + boundary.encode()
    fields: dict[str, str] = {}
    files: list[tuple[str, bytes]] = []
    for part in body.split(marker):
        if b"Content-Disposition" not in part:
            continue
        header, _, data = part.partition(b"\r\n\r\n")
        if data.endswith(b"\r\n"):
            data = data[:-2]
        text = header.decode("utf-8", "replace")
        star = re.search(r"filename\*=UTF-8''([^;\r\n]+)", text, re.I)
        quoted = re.search(r'filename="([^"]*)"', text)
        plain = re.search(r"filename=([^;\r\n]+)", text)
        if star or quoted or plain:
            if star:
                filename = unquote(star.group(1)).strip()
            elif quoted:
                filename = quoted.group(1)
            else:
                filename = plain.group(1).strip().strip('"')
            filename = Path(filename).name
            if filename:
                files.append((filename, data))
            continue
        name_match = re.search(r'name="([^"]+)"', text)
        if name_match:
            fields[name_match.group(1)] = data.decode("utf-8", "replace")
    return fields, files


def _corners_from_client(raw, width: int, height: int) -> np.ndarray:
    if not isinstance(raw, list) or len(raw) != 4:
        raise ValueError("需要 4 个角点")
    points = []
    for item in raw:
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            raise ValueError("角点格式不正确")
        x, y = float(item[0]), float(item[1])
        if not np.isfinite(x) or not np.isfinite(y):
            raise ValueError("角点无效")
        points.append([x, y])
    quad = detect.order_points(np.array(points, np.float32))
    margin_x, margin_y = 0.2 * width, 0.2 * height
    if quad[:, 0].min() < -margin_x or quad[:, 0].max() > width + margin_x:
        raise ValueError("角点超出图片范围")
    if quad[:, 1].min() < -margin_y or quad[:, 1].max() > height + margin_y:
        raise ValueError("角点超出图片范围")
    if not detect.valid_quad(quad, width, height):
        # valid_quad is strict about angles; still allow a user-drawn quad that is merely convex.
        area = float(cv2_area(quad))
        if area < 0.02 * width * height:
            raise ValueError("选区太小")
    return quad


def cv2_area(quad: np.ndarray) -> float:
    import cv2
    return float(cv2.contourArea(quad.astype(np.float32)))


def _page_payload(page: dict) -> dict:
    return {
        "id": page["id"],
        "name": page["name"],
        "width": page["width"],
        "height": page["height"],
        "corners": np.round(page["corners"], 1).tolist(),
        "confidence": round(float(page["confidence"]), 2),
    }


def _add_files(session_id: str, files: list[tuple[str, bytes]]) -> list[dict]:
    session = _session(session_id)
    if len(session["pages"]) + len(files) > MAX_PAGES:
        raise ValueError(f"一次最多 {MAX_PAGES} 张")
    added = []
    for filename, data in files:
        suffix = Path(filename).suffix.lower()
        if suffix not in ALLOWED:
            raise ValueError(f"不支持的格式：{filename}")
        if not data:
            raise ValueError(f"空文件：{filename}")
        page_id = uuid.uuid4().hex
        try:
            image = detect.load_bgr_bytes(data)
        except Exception as exc:
            raise ValueError(f"无法读取 {filename}") from exc
        del data
        corners, confidence = detect.detect_quad(image)
        page = {
            "id": page_id,
            "name": filename,
            "image": image,
            "width": int(image.shape[1]),
            "height": int(image.shape[0]),
            "corners": corners,
            "confidence": confidence,
            "preview": detect.encode_jpeg(detect._resize_max(image, 1400)[0], 82),
        }
        with _lock:
            session["pages"][page_id] = page
        added.append(_page_payload(page))
    return added


def _pdf_filename(raw) -> str:
    name = Path(str(raw or "")).name
    name = re.sub(r'[\/:*?"<>|\r\n]', "", name).strip().strip(".")
    if name.lower().endswith(".pdf"):
        name = name[:-4].strip().strip(".")
    return (name or "会议PPT")[:80] + ".pdf"


def _attachment(filename: str) -> str:
    return f"attachment; filename=\"slides.pdf\"; filename*=UTF-8''{quote(filename)}"


def _warp_page(page: dict, corners: np.ndarray, aspect: str, width: int, pad: float):
    if aspect not in detect.ASPECTS:
        raise ValueError("未知的宽高比")
    width = int(width)
    if width < 640 or width > 4096:
        raise ValueError("输出宽度需在 640 到 4096 之间")
    pad = float(pad)
    if pad < -0.35 or pad > 0.35:
        raise ValueError("框的缩放超出范围")
    return detect.warp_slide(page["image"], corners, aspect, width, pad=pad)


class Handler(BaseHTTPRequestHandler):
    server_version = "ppt-organizer/1.0"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {self.address_string()} {fmt % args}")

    def _send(self, status: int, body: bytes, content_type: str, filename: str | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if filename:
            self.send_header("Content-Disposition", _attachment(filename))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload: dict) -> None:
        self._send(status, json.dumps(payload, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > MAX_BODY:
            raise ValueError("上传内容过大")
        return self.rfile.read(length)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path in ("/", "/index.html"):
            self._send(200, INDEX.read_bytes(), "text/html; charset=utf-8")
            return
        parts = [unquote(part) for part in parsed.path.split("/") if part]
        if len(parts) == 3 and parts[0] == "api" and parts[1] == "file":
            self._send_saved_pdf(parts[2])
            return
        if len(parts) == 4 and parts[0] == "api" and parts[1] == "image":
            try:
                page = _session(parts[2])["pages"][parts[3]]
            except KeyError:
                self._json(404, {"error": "找不到这张图片"})
                return
            self._send(200, page["preview"], "image/jpeg")
            return
        self._json(404, {"error": "没有这个页面"})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/upload":
                self._upload()
            elif parsed.path == "/api/preview":
                self._preview()
            elif parsed.path == "/api/redetect":
                self._redetect()
            elif parsed.path == "/api/pdf":
                self._pdf()
            elif parsed.path == "/api/discard":
                self._discard()
            else:
                self._json(404, {"error": "没有这个接口"})
        except (KeyError, ValueError) as exc:
            self._json(400, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            self._json(500, {"error": f"处理失败：{exc}"})

    def _upload(self) -> None:
        body = self._read_body()
        fields, files = _parse_multipart(self.headers.get("Content-Type", ""), body)
        if not files:
            raise ValueError("没有收到图片")
        session_id = fields.get("session") or ""
        if session_id:
            _session(session_id)
        else:
            session_id = _new_session()
        pages = _add_files(session_id, files)
        self._json(200, {"session": session_id, "pages": pages})

    def _page_and_corners(self, payload: dict) -> tuple[dict, np.ndarray]:
        session = _session(str(payload.get("session", "")))
        page = session["pages"].get(str(payload.get("id", "")))
        if page is None:
            raise KeyError("找不到这张图片")
        corners = _corners_from_client(payload.get("corners"), page["width"], page["height"])
        return page, corners

    def _preview(self) -> None:
        payload = json.loads(self._read_body().decode())
        page, corners = self._page_and_corners(payload)
        warped = _warp_page(page, corners, payload.get("aspect", "16:9"), int(payload.get("width", 1200)), float(payload.get("pad", 0)))
        if payload.get("detail"):
            preview, quality = warped, 90
        else:
            preview, quality = detect._resize_max(warped, 1100)[0], 84
        self._send(200, detect.encode_jpeg(preview, quality), "image/jpeg")

    def _redetect(self) -> None:
        payload = json.loads(self._read_body().decode())
        session = _session(str(payload.get("session", "")))
        page = session["pages"].get(str(payload.get("id", "")))
        if page is None:
            raise KeyError("找不到这张图片")
        corners, confidence = detect.detect_quad(page["image"])
        page["corners"] = corners
        page["confidence"] = confidence
        self._json(200, _page_payload(page))

    def _pdf(self) -> None:
        payload = json.loads(self._read_body().decode())
        session = _session(str(payload.get("session", "")))
        items = payload.get("pages")
        if not isinstance(items, list) or not items:
            raise ValueError("没有要导出的页面")
        aspect = payload.get("aspect", "16:9")
        width = int(payload.get("width", 1920))
        pad = float(payload.get("pad", 0))
        images = []
        for item in items:
            page = session["pages"].get(str(item.get("id", "")))
            if page is None:
                raise KeyError("有页面已失效，请重新上传")
            corners = _corners_from_client(item.get("corners"), page["width"], page["height"])
            images.append(_warp_page(page, corners, aspect, width, pad))
        pdf = detect.images_to_pdf(images)
        filename = _pdf_filename(payload.get("filename"))
        token = _remember_pdf(pdf, filename)
        self._json(200, {"url": f"/api/file/{token}", "filename": filename})

    def _send_saved_pdf(self, token: str) -> None:
        if not re.fullmatch(r"[0-9a-f]{32}", token or ""):
            self._json(404, {"error": "下载链接无效"})
            return
        with _lock:
            item = _downloads.get(token)
        if item is None:
            self._json(404, {"error": "下载链接已失效，请重新生成"})
            return
        body = item["data"]
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Disposition", _attachment(item["filename"]))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _discard(self) -> None:
        try:
            payload = json.loads(self._read_body().decode() or "{}")
        except json.JSONDecodeError:
            payload = {}
        _drop_session(str(payload.get("session", "")))
        self._json(200, {"ok": True})


def resolve_host(value: str) -> str:
    host = value.strip()
    if host in {"*", "0.0.0.0"}:
        return "0.0.0.0"
    if not host:
        return "127.0.0.1"
    return host


def main() -> None:
    parser = argparse.ArgumentParser(description="开会 PPT 照片整理")
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"), help="监听地址，默认 127.0.0.1；* 或 0.0.0.0 表示全部网卡")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8765")), help="监听端口，默认 8765")
    args = parser.parse_args()
    host = resolve_host(args.host)
    server = ThreadingHTTPServer((host, args.port), Handler)
    shown = "127.0.0.1" if host == "0.0.0.0" else host
    print(f"开会 PPT 整理：http://{shown}:{args.port}/")
    if host == "0.0.0.0":
        print("当前监听全部网卡。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
