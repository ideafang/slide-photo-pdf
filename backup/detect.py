"""Locate a photographed slide and warp it to a frontal rectangle."""

from __future__ import annotations

import argparse
import io
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

register_heif_opener()

ASPECTS = {
    "16:9": 16 / 9,
    "4:3": 4 / 3,
    "16:10": 16 / 10,
    "3:2": 3 / 2,
    "free": None,
}


def _bgr_from_pil(image: Image.Image) -> np.ndarray:
    image = ImageOps.exif_transpose(image)
    image = image.convert("RGB")
    rgb = np.asarray(image)
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


def load_bgr(path: str | Path) -> np.ndarray:
    with Image.open(path) as image:
        return _bgr_from_pil(image)


def load_bgr_bytes(data: bytes) -> np.ndarray:
    with Image.open(io.BytesIO(data)) as image:
        return _bgr_from_pil(image)


def order_points(pts: np.ndarray) -> np.ndarray:
    pts = np.asarray(pts, dtype=np.float32).reshape(4, 2)
    rect = np.zeros((4, 2), dtype=np.float32)
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).reshape(-1)
    rect[0] = pts[np.argmin(s)]  # top-left
    rect[2] = pts[np.argmax(s)]  # bottom-right
    rect[1] = pts[np.argmin(d)]  # top-right
    rect[3] = pts[np.argmax(d)]  # bottom-left
    return rect


def _angdiff(a: float, b: float) -> float:
    return abs((a - b + 180) % 360 - 180)


def _parallel_diff(a: float, b: float) -> float:
    """Difference of two undirected line angles. 0 and 180 degrees are the same line."""
    direct = _angdiff(a, b)
    return min(direct, 180 - direct)


def valid_quad(quad: np.ndarray | None, width: int, height: int) -> bool:
    if quad is None or quad.shape != (4, 2) or not np.all(np.isfinite(quad)):
        return False
    area = float(cv2.contourArea(quad.astype(np.float32)))
    if area < 0.08 * width * height or area > 0.93 * width * height:
        return False
    if quad[:, 0].min() < -0.12 * width or quad[:, 1].min() < -0.12 * height:
        return False
    if quad[:, 0].max() > 1.12 * width or quad[:, 1].max() > 1.12 * height:
        return False
    limit = 0.05 * max(width, height)
    for i in range(4):
        p0, p1, p2 = quad[(i - 1) % 4], quad[i], quad[(i + 1) % 4]
        v1, v2 = p0 - p1, p2 - p1
        n1, n2 = float(np.linalg.norm(v1)), float(np.linalg.norm(v2))
        if min(n1, n2) < limit:
            return False
        cos = float(np.clip(np.dot(v1, v2) / (n1 * n2), -1, 1))
        angle = float(np.degrees(np.arccos(cos)))
        if angle < 38 or angle > 148:
            return False
    return True


def _resize_max(image: np.ndarray, max_side: int = 1100) -> tuple[np.ndarray, float]:
    height, width = image.shape[:2]
    scale = max_side / max(height, width)
    if scale >= 1:
        return image, 1.0
    resized = cv2.resize(image, (int(width * scale), int(height * scale)), interpolation=cv2.INTER_AREA)
    return resized, scale


def _largest_mask(blur: np.ndarray, percentile: float) -> tuple[np.ndarray | None, np.ndarray | None]:
    threshold = float(np.percentile(blur, percentile))
    raw = (blur >= threshold).astype(np.uint8) * 255
    height, width = blur.shape
    kernel_size = max(5, int(round(0.012 * max(width, height))) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_size, kernel_size))
    mask = cv2.morphologyEx(raw, cv2.MORPH_CLOSE, kernel, iterations=2)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None, None
    contour = max(contours, key=cv2.contourArea)
    if cv2.contourArea(contour) < 0.08 * width * height:
        return None, None
    clean = np.zeros_like(mask)
    cv2.drawContours(clean, [contour], -1, 255, thickness=-1)
    return clean, contour


def _extreme_quad(contour: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    hull = cv2.convexHull(contour).reshape(-1, 2).astype(np.float32)
    s = hull.sum(axis=1)
    d = np.diff(hull, axis=1).reshape(-1)
    quad = np.stack([
        hull[np.argmin(s)],
        hull[np.argmin(d)],
        hull[np.argmax(s)],
        hull[np.argmax(d)],
    ]).astype(np.float32)
    return order_points(quad), hull


def _line_of(a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    vector = b - a
    direction = (vector / (np.linalg.norm(vector) + 1e-6)).astype(np.float32)
    return a.astype(np.float32), direction


def _signed_distance(point: np.ndarray, origin: np.ndarray, direction: np.ndarray) -> float:
    delta = point - origin
    return float(delta[0] * (-direction[1]) + delta[1] * direction[0])


def _intersect(line1, line2) -> np.ndarray | None:
    origin1, dir1 = line1
    origin2, dir2 = line2
    denom = float(dir1[0] * dir2[1] - dir1[1] * dir2[0])
    if abs(denom) < 1e-6:
        return None
    t = ((origin2[0] - origin1[0]) * dir2[1] - (origin2[1] - origin1[1]) * dir2[0]) / denom
    return origin1 + t * dir1


def _boundary_segments(gray: np.ndarray, mask: np.ndarray) -> list[dict]:
    height, width = gray.shape
    band = max(8, int(0.025 * max(height, width))) | 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (band, band))
    ring = cv2.subtract(cv2.dilate(mask, kernel), cv2.erode(mask, kernel))
    edges = cv2.Canny(cv2.GaussianBlur(gray, (3, 3), 0), 30, 110)
    edges = cv2.bitwise_and(edges, ring)
    min_len = int(0.07 * max(height, width))
    lines = cv2.HoughLinesP(
        edges, 1, np.pi / 180, threshold=30,
        minLineLength=min_len, maxLineGap=int(0.03 * max(height, width)),
    )
    segments = []
    if lines is None:
        return segments
    for x1, y1, x2, y2 in lines.reshape(-1, 4):
        a = np.array([x1, y1], np.float32)
        b = np.array([x2, y2], np.float32)
        segments.append({
            "a": a,
            "b": b,
            "len": float(np.linalg.norm(b - a)),
            "ang": float(np.degrees(np.arctan2(b[1] - a[1], b[0] - a[0]))),
            "mid": (a + b) / 2,
        })
    return segments


def _snap_quad(gray: np.ndarray, mask: np.ndarray, contour: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Pull each side of the initial quad onto the outermost nearby border line."""
    height, width = gray.shape
    initial, hull = _extreme_quad(contour)
    center = hull.mean(axis=0)
    segments = _boundary_segments(gray, mask)
    lines = []
    search = 0.1 * max(height, width)
    for index in range(4):
        a, b = initial[index], initial[(index + 1) % 4]
        edge_angle = float(np.degrees(np.arctan2(b[1] - a[1], b[0] - a[0])))
        tangent = (b - a) / (np.linalg.norm(b - a) + 1e-6)
        normal = np.array([-tangent[1], tangent[0]], np.float32)
        if np.dot(normal, (a + b) / 2 - center) < 0:
            normal = -normal
        origin, direction = _line_of(a, b)
        nearby = []
        for segment in segments:
            if _angdiff(segment["ang"], edge_angle) > 32:
                continue
            if abs(_signed_distance(segment["mid"], origin, direction)) > search:
                continue
            outward = float(np.dot(segment["mid"] - center, normal))
            nearby.append((outward, segment))
        if not nearby:
            lines.append((origin, direction))
            continue
        nearby.sort(key=lambda item: -item[0])
        best = nearby[0][1]
        best_origin, best_dir = _line_of(best["a"], best["b"])
        agree = [best]
        for _, segment in nearby:
            same_line = abs(_signed_distance(segment["mid"], best_origin, best_dir)) < 0.02 * max(height, width)
            if same_line and _angdiff(segment["ang"], best["ang"]) < 12:
                agree.append(segment)
        points = np.vstack([np.vstack([segment["a"], segment["b"]]) for segment in agree])
        vx, vy, x0, y0 = cv2.fitLine(points.astype(np.float32), cv2.DIST_L2, 0, 0.01, 0.01).reshape(-1)
        lines.append((np.array([x0, y0], np.float32), np.array([vx, vy], np.float32)))
    corners = []
    for index in range(4):
        corner = _intersect(lines[(index - 1) % 4], lines[index])
        if corner is None:
            return initial, initial
        corners.append(corner)
    quad = order_points(np.array(corners, np.float32))
    if not valid_quad(quad, width, height):
        return initial, initial
    if np.linalg.norm(quad - initial, axis=1).max() > 0.22 * max(height, width):
        return initial, initial
    return quad, initial


def _long_edge_quad(contour: np.ndarray) -> np.ndarray | None:
    """Fit four lines to the long outer edges of the convex hull."""
    hull = cv2.convexHull(contour).reshape(-1, 2).astype(np.float32)
    count = len(hull)
    if count < 4:
        return None
    min_len = 0.07 * cv2.arcLength(hull, True)
    segments = []
    for index in range(count):
        a, b = hull[index], hull[(index + 1) % count]
        length = float(np.linalg.norm(b - a))
        if length < min_len:
            continue
        angle = float(np.degrees(np.arctan2(b[1] - a[1], b[0] - a[0])))
        segments.append((length, angle, a, b, (a + b) / 2))
    if len(segments) < 4:
        return None
    clusters: list[dict] = []
    for length, angle, a, b, mid in sorted(segments, reverse=True):
        placed = False
        for cluster in clusters:
            if _angdiff(angle, cluster["ang"]) > 18:
                continue
            vx, vy, x0, y0 = cv2.fitLine(cluster["pts"], cv2.DIST_L2, 0, 0.01, 0.01).reshape(-1)
            origin = np.array([x0, y0])
            direction = np.array([vx, vy])
            delta = mid - origin
            distance = abs(float(delta[0] * (-direction[1]) + delta[1] * direction[0]))
            if distance < 18:
                cluster["pts"] = np.vstack([cluster["pts"], a, b])
                cluster["len"] += length
                fitted = cv2.fitLine(cluster["pts"], cv2.DIST_L2, 0, 0.01, 0.01).reshape(-1)
                cluster["ang"] = float(np.degrees(np.arctan2(fitted[1], fitted[0])))
                placed = True
                break
        if not placed:
            clusters.append({"pts": np.vstack([a, b]), "ang": angle, "len": length})
    clusters = sorted(clusters, key=lambda item: -item["len"])[:4]
    if len(clusters) < 4:
        return None
    lines = []
    for cluster in clusters:
        vx, vy, x0, y0 = cv2.fitLine(cluster["pts"], cv2.DIST_L2, 0, 0.01, 0.01).reshape(-1)
        origin = np.array([x0, y0], np.float32)
        direction = np.array([vx, vy], np.float32)
        lines.append((origin, direction, cluster["pts"].mean(axis=0)))
    center = np.mean([line[2] for line in lines], axis=0)
    lines.sort(key=lambda line: np.arctan2(line[2][1] - center[1], line[2][0] - center[0]))
    corners = []
    for index in range(4):
        corner = _intersect(lines[index][:2], lines[(index + 1) % 4][:2])
        if corner is None:
            return None
        corners.append(corner)
    return order_points(np.array(corners, np.float32))


def _axis_deviation(gray: np.ndarray) -> float:
    edges = cv2.Canny(cv2.GaussianBlur(gray, (3, 3), 0), 40, 120)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=40, minLineLength=70, maxLineGap=12)
    if lines is None or len(lines) < 4:
        return 8.0
    deviations = []
    lengths = []
    for x1, y1, x2, y2 in lines.reshape(-1, 4):
        length = float(np.hypot(x2 - x1, y2 - y1))
        angle = abs(float(np.degrees(np.arctan2(y2 - y1, x2 - x1)))) % 180
        deviations.append(min(angle, abs(angle - 90), abs(angle - 180)))
        lengths.append(length)
    deviations = np.asarray(deviations)
    lengths = np.asarray(lengths)
    keep = lengths >= np.percentile(lengths, 40)
    if not np.any(keep):
        return 8.0
    return float(np.average(deviations[keep], weights=lengths[keep]))


def _border_roughness(gray: np.ndarray) -> float:
    height, width = gray.shape
    band = max(4, int(0.04 * height))
    strips = (gray[:band], gray[-band:], gray[:, :band], gray[:, -band:])
    scores = [float(np.mean(np.abs(cv2.Laplacian(strip, cv2.CV_32F)))) for strip in strips]
    return float(max(scores))


def _fit_edge_line(points: np.ndarray, normal: np.ndarray, edge_angle: float, length: float):
    """Fit one border line, preferring the outer consistent points."""
    if len(points) < 8:
        return None
    projection = (points - points.mean(axis=0)) @ normal
    outer = points[projection >= np.percentile(projection, 42)]
    if len(outer) < 8:
        outer = points
    band = max(2.6, 0.008 * length)

    def fit(samples: np.ndarray):
        vx, vy, x0, y0 = cv2.fitLine(samples.astype(np.float32), cv2.DIST_HUBER, 0, 0.01, 0.01).reshape(-1)
        origin = np.array([x0, y0], np.float32)
        direction = np.array([vx, vy], np.float32)
        angle = float(np.degrees(np.arctan2(direction[1], direction[0])))
        if _parallel_diff(angle, edge_angle) > 14:
            return None, samples[:0]
        distance = np.array([abs(_signed_distance(point, origin, direction)) for point in samples])
        inliers = samples[distance <= band]
        return (origin, direction), inliers

    line, inliers = fit(outer)
    if line is None:
        return None
    if len(inliers) >= 8:
        refined, refined_inliers = fit(inliers)
        if refined is not None and len(refined_inliers) >= 6:
            line = refined
    return line


def _calibrate_by_border_lines(gray: np.ndarray, quad: np.ndarray) -> np.ndarray:
    """Replace corners with intersections of the four slide border lines.

    Corners are often hidden by a person or a podium. Each side is scanned for the
    long bright-to-dark edge, and the visible parts of that line fix the corner.
    """
    height, width = gray.shape
    quad = order_points(quad)
    if not valid_quad(quad, width, height):
        return quad
    center = quad.mean(axis=0)
    mask = np.zeros((height, width), np.uint8)
    cv2.fillConvexPoly(mask, np.round(quad).astype(np.int32), 255)
    core = cv2.erode(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (31, 31)))
    values = gray[core > 0] if np.count_nonzero(core) > 50 else gray[mask > 0]
    if len(values) < 20:
        return quad
    bright_floor = max(130.0, float(np.percentile(values, 40)) * 0.72)
    lines = []
    for index in range(4):
        start = quad[index].astype(np.float32)
        end = quad[(index + 1) % 4].astype(np.float32)
        tangent = end - start
        length = float(np.linalg.norm(tangent)) + 1e-6
        tangent = tangent / length
        normal = np.array([-tangent[1], tangent[0]], np.float32)
        if float(np.dot(normal, (start + end) / 2 - center)) < 0:
            normal = -normal
        fallback = _line_of(start, end)
        offsets = np.linspace(-0.26 * length, 0.12 * length, 110)
        step = float(offsets[1] - offsets[0])
        sustain = max(4, int(round(12.0 / max(step, 1.0))))
        span = max(3, int(round(9.0 / max(step, 1.0))))
        points = []
        for t in np.linspace(0.04, 0.96, 52):
            base = start * (1 - t) + end * t
            coords = base + offsets[:, None] * normal
            xs = np.clip(coords[:, 0], 0, width - 1).astype(np.float32)
            ys = np.clip(coords[:, 1], 0, height - 1).astype(np.float32)
            outside = (coords[:, 0] < 1) | (coords[:, 0] > width - 2) | (coords[:, 1] < 1) | (coords[:, 1] > height - 2)
            samples = cv2.remap(gray, xs.reshape(-1, 1), ys.reshape(-1, 1), cv2.INTER_LINEAR).reshape(-1).astype(np.float32)
            samples[outside] = 0
            chosen = None
            for idx in range(sustain + 1, len(samples) - span - 1):
                inward = samples[idx - sustain:idx]
                outward = samples[idx + 1:idx + 1 + span]
                # The outside of a slide edge is the dark screen or room, not another colored bar.
                if float(np.median(inward)) < bright_floor or float(np.median(outward)) > 85:
                    continue
                if float(np.median(inward) - np.median(outward)) < 55:
                    continue
                chosen = idx
            if chosen is not None:
                points.append(coords[chosen])
        edge_angle = float(np.degrees(np.arctan2(tangent[1], tangent[0])))
        fitted = _fit_edge_line(np.array(points, np.float32), normal, edge_angle, length) if points else None
        if fitted is None:
            lines.append(fallback)
            continue
        outward_shift = float(np.dot(fitted[0] - (start + end) / 2, normal))
        if abs(outward_shift) > 0.12 * max(height, width):
            lines.append(fallback)
            continue
        # Keep the border pixel itself instead of cutting into the slide.
        nudge = max(1.8, 0.008 * length)
        lines.append((fitted[0] + normal * nudge, fitted[1]))
    corners = []
    for index in range(4):
        corner = _intersect(lines[(index - 1) % 4], lines[index])
        if corner is None:
            return quad
        corners.append(corner)
    refined = order_points(np.array(corners, np.float32))
    if not valid_quad(refined, width, height):
        return quad
    if np.linalg.norm(refined - quad, axis=1).max() > 0.18 * max(height, width):
        return quad
    return refined


def _candidate_score(image: np.ndarray, quad: np.ndarray) -> float:
    height, width = image.shape[:2]
    if not valid_quad(quad, width, height):
        return -1e9
    warped = warp_slide(image, quad, "16:9", out_w=640)
    gray = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY)
    roughness = _border_roughness(gray)
    deviation = _axis_deviation(gray)
    area_frac = float(cv2.contourArea(quad)) / (width * height)
    # Smooth borders mean the cut is not running through slide text.
    # Axis deviation matters for oblique shots: a cleaner border that is still
    # skewed loses to a slightly rougher but frontal crop.
    return -roughness - 14.0 * deviation + 10.0 * area_frac


def detect_quad(image: np.ndarray) -> tuple[np.ndarray, float]:
    """Return slide corners in the original image and a 0–1 confidence."""
    full_h, full_w = image.shape[:2]
    small, scale = _resize_max(image, 1100)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    luminance = cv2.cvtColor(small, cv2.COLOR_BGR2LAB)[:, :, 0]
    height, width = gray.shape
    blur = cv2.GaussianBlur(luminance, (0, 0), sigmaX=max(3.0, 0.012 * max(height, width)))

    best_quad = None
    best_score = -1e9
    for percentile in (46, 50, 54, 58, 62, 66, 72):
        mask, contour = _largest_mask(blur, percentile)
        if contour is None:
            continue
        snapped, initial = _snap_quad(gray, mask, contour)
        candidates = [snapped, initial, _long_edge_quad(contour)]
        for quad in candidates:
            score = _candidate_score(small, quad)
            if score > best_score:
                best_score = score
                best_quad = quad

    if best_quad is None:
        best_quad = np.array([
            [0.15 * width, 0.18 * height],
            [0.85 * width, 0.18 * height],
            [0.85 * width, 0.82 * height],
            [0.15 * width, 0.82 * height],
        ], np.float32)
        best_score = -80.0
    else:
        best_quad = _calibrate_by_border_lines(gray, order_points(best_quad))

    full_quad = order_points(best_quad / scale)
    # Roughness of a clean slide border is usually under ~25; text-cutting borders are higher.
    confidence = float(np.clip((best_score + 55.0) / 45.0, 0.0, 1.0))
    full_quad[:, 0] = np.clip(full_quad[:, 0], 0, full_w - 1)
    full_quad[:, 1] = np.clip(full_quad[:, 1], 0, full_h - 1)
    return full_quad, confidence


def expand_quad(quad: np.ndarray, ratio: float) -> np.ndarray:
    quad = order_points(quad)
    ratio = float(np.clip(ratio, -0.35, 0.35))
    if abs(ratio) < 1e-6:
        return quad
    center = quad.mean(axis=0)
    return order_points(center + (quad - center) * (1 + ratio))


def output_size(quad: np.ndarray, aspect: str, out_w: int) -> tuple[int, int]:
    ratio = ASPECTS[aspect]
    out_w = int(np.clip(out_w, 640, 4096))
    if ratio is None:
        ordered = order_points(quad)
        top = float(np.linalg.norm(ordered[1] - ordered[0]))
        bottom = float(np.linalg.norm(ordered[2] - ordered[3]))
        left = float(np.linalg.norm(ordered[3] - ordered[0]))
        right = float(np.linalg.norm(ordered[2] - ordered[1]))
        ratio = max(top, bottom) / max(1.0, max(left, right))
        ratio = float(np.clip(ratio, 0.5, 2.4))
    out_h = max(1, int(round(out_w / ratio)))
    return out_w, out_h


def warp_slide(image: np.ndarray, quad: np.ndarray, aspect: str = "16:9", out_w: int = 1920, pad: float = 0.0) -> np.ndarray:
    quad = expand_quad(quad, pad)
    width, height = output_size(quad, aspect, out_w)
    destination = np.array([
        [0, 0],
        [width - 1, 0],
        [width - 1, height - 1],
        [0, height - 1],
    ], np.float32)
    matrix = cv2.getPerspectiveTransform(order_points(quad), destination)
    interpolation = cv2.INTER_AREA if max(image.shape[:2]) > max(width, height) * 1.4 else cv2.INTER_CUBIC
    return cv2.warpPerspective(
        image, matrix, (width, height),
        flags=interpolation,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(255, 255, 255),
    )


def encode_jpeg(image: np.ndarray, quality: int = 88) -> bytes:
    ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, int(quality)])
    if not ok:
        raise RuntimeError("JPEG 编码失败")
    return encoded.tobytes()


def images_to_pdf(images: list[np.ndarray], quality: int = 90) -> bytes:
    """Embed warped slides as JPEG pages. Page width is 11 inches."""
    if not images:
        raise ValueError("没有可写入的页面")
    page_width = 792.0  # 11 in
    jpeg_blobs = []
    page_sizes = []
    for image in images:
        height, width = image.shape[:2]
        page_height = page_width * height / width
        jpeg_blobs.append(encode_jpeg(image, quality))
        page_sizes.append((page_width, page_height, width, height))

    objects: list[bytes] = []

    def add(data: bytes) -> int:
        objects.append(data)
        return len(objects)

    page_ids = []
    content_ids = []
    image_ids = []
    for blob, (page_w, page_h, width, height) in zip(jpeg_blobs, page_sizes):
        content = f"q {page_w:.2f} 0 0 {page_h:.2f} 0 0 cm /Im0 Do Q".encode()
        content_ids.append(add(
            b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream"
        ))
        image_ids.append(add(
            (
                f"<< /Type /XObject /Subtype /Image /Width {width} /Height {height} "
                f"/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {len(blob)} >>\nstream\n"
            ).encode() + blob + b"\nendstream"
        ))
        page_ids.append(None)  # filled after the pages tree id is known

    pages_id = add(b"")  # placeholder, rewritten below
    catalog_id = add(b"")
    for index, ((page_w, page_h, _, _), content_id, image_id) in enumerate(zip(page_sizes, content_ids, image_ids)):
        page_ids[index] = add(
            (
                f"<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 {page_w:.2f} {page_h:.2f}] "
                f"/Resources << /XObject << /Im0 {image_id} 0 R >> >> /Contents {content_id} 0 R >>"
            ).encode()
        )
    kids = " ".join(f"{page_id} 0 R" for page_id in page_ids)
    objects[pages_id - 1] = f"<< /Type /Pages /Count {len(page_ids)} /Kids [{kids}] >>".encode()
    objects[catalog_id - 1] = f"<< /Type /Catalog /Pages {pages_id} 0 R >>".encode()

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{index} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for offset in offsets[1:]:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root {catalog_id} 0 R >>\n"
        f"startxref\n{xref}\n%%EOF\n"
    ).encode()
    return bytes(out)


def main() -> None:
    parser = argparse.ArgumentParser(description="把拍摄的 PPT 照片矫正并合并为 PDF")
    parser.add_argument("images", nargs="+")
    parser.add_argument("-o", "--output", default="slides.pdf")
    parser.add_argument("--aspect", default="16:9", choices=sorted(ASPECTS))
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--pad", type=float, default=0.0)
    parser.add_argument("--debug-dir", default="")
    args = parser.parse_args()
    warped = []
    debug_dir = Path(args.debug_dir) if args.debug_dir else None
    if debug_dir:
        debug_dir.mkdir(parents=True, exist_ok=True)
    for path in args.images:
        image = load_bgr(path)
        quad, confidence = detect_quad(image)
        page = warp_slide(image, quad, args.aspect, args.width, pad=args.pad)
        warped.append(page)
        print(f"{Path(path).name}\tconfidence={confidence:.2f}\tcorners={np.round(quad).astype(int).tolist()}")
        if debug_dir:
            preview, scale = _resize_max(image, 1200)
            vis = preview.copy()
            draw = np.round(quad * scale).astype(np.int32)
            cv2.polylines(vis, [draw], True, (0, 0, 255), 2)
            cv2.imwrite(str(debug_dir / f"{Path(path).stem}_quad.jpg"), vis)
            cv2.imwrite(str(debug_dir / f"{Path(path).stem}_warp.jpg"), page)
    pdf = images_to_pdf(warped)
    Path(args.output).write_bytes(pdf)
    print(f"wrote {args.output} ({len(pdf)} bytes, {len(warped)} pages)")


if __name__ == "__main__":
    main()
