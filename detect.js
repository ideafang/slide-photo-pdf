/* Browser port of the Python slide detector. Geometry stays in plain numbers;
   OpenCV.js is used only for image operations. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SlideLocal = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const ASPECTS = { "16:9": 16 / 9, "4:3": 4 / 3, "16:10": 16 / 10, "3:2": 3 / 2, free: null };

  function create(cv) {
    function linspace(a, b, n) {
      const out = new Float64Array(n);
      if (n <= 1) {
        if (n === 1) out[0] = a;
        return out;
      }
      const step = (b - a) / (n - 1);
      for (let i = 0; i < n; i++) out[i] = a + step * i;
      return out;
    }

    function percentile(values, p) {
      const n = values.length;
      if (!n) return 0;
      const rank = (p / 100) * (n - 1);
      const lo = Math.floor(rank);
      const hi = Math.ceil(rank);
      const sorted = values.slice().sort((a, b) => a - b);
      if (lo === hi) return sorted[lo];
      return sorted[lo] * (hi - rank) + sorted[hi] * (rank - lo);
    }

    function percentileHist(hist, n, p) {
      if (!n) return 0;
      const rank = (p / 100) * (n - 1);
      const at = (index) => {
        let acc = 0;
        for (let v = 0; v < 256; v++) {
          if (acc + hist[v] > index) return v;
          acc += hist[v];
        }
        return 255;
      };
      const lo = Math.floor(rank);
      const hi = Math.ceil(rank);
      if (lo === hi) return at(lo);
      return at(lo) * (hi - rank) + at(hi) * (rank - lo);
    }

    function percentileU8(data, p) {
      const n = data.length;
      if (!n) return 0;
      const hist = new Uint32Array(256);
      for (let i = 0; i < n; i++) hist[data[i]]++;
      return percentileHist(hist, n, p);
    }

    const medianBuf = new Float64Array(64);
    function medianRange(samples, start, end) {
      const n = end - start;
      if (n <= 0) return 0;
      if (n <= medianBuf.length) {
        for (let i = 0; i < n; i++) {
          const v = samples[start + i];
          let j = i - 1;
          while (j >= 0 && medianBuf[j] > v) {
            medianBuf[j + 1] = medianBuf[j];
            j--;
          }
          medianBuf[j + 1] = v;
        }
        const mid = n >> 1;
        return (n & 1) ? medianBuf[mid] : (medianBuf[mid - 1] + medianBuf[mid]) * 0.5;
      }
      const tmp = [];
      for (let i = start; i < end; i++) tmp.push(samples[i]);
      tmp.sort((a, b) => a - b);
      const mid = n >> 1;
      return (n & 1) ? tmp[mid] : (tmp[mid - 1] + tmp[mid]) * 0.5;
    }

    function clonePt(p) {
      return [p[0], p[1]];
    }

    function orderPoints(pts) {
      let iMinS = 0, iMaxS = 0, iMinD = 0, iMaxD = 0;
      const sum = (p) => p[0] + p[1];
      const diff = (p) => p[1] - p[0];
      for (let i = 1; i < 4; i++) {
        if (sum(pts[i]) < sum(pts[iMinS])) iMinS = i;
        if (sum(pts[i]) > sum(pts[iMaxS])) iMaxS = i;
        if (diff(pts[i]) < diff(pts[iMinD])) iMinD = i;
        if (diff(pts[i]) > diff(pts[iMaxD])) iMaxD = i;
      }
      return [clonePt(pts[iMinS]), clonePt(pts[iMinD]), clonePt(pts[iMaxS]), clonePt(pts[iMaxD])];
    }

    function angDiff(a, b) {
      return Math.abs(((a - b + 180) % 360) - 180);
    }

    function parallelDiff(a, b) {
      const direct = angDiff(a, b);
      return Math.min(direct, 180 - direct);
    }

    function shoelace(pts) {
      let s = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        s += a[0] * b[1] - b[0] * a[1];
      }
      return Math.abs(s) / 2;
    }

    function validQuad(quad, width, height) {
      if (!quad || quad.length !== 4) return false;
      for (const p of quad) {
        if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return false;
      }
      const area = shoelace(quad);
      if (area < 0.08 * width * height || area > 0.93 * width * height) return false;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of quad) {
        minX = Math.min(minX, p[0]);
        minY = Math.min(minY, p[1]);
        maxX = Math.max(maxX, p[0]);
        maxY = Math.max(maxY, p[1]);
      }
      if (minX < -0.12 * width || minY < -0.12 * height) return false;
      if (maxX > 1.12 * width || maxY > 1.12 * height) return false;
      const limit = 0.05 * Math.max(width, height);
      for (let i = 0; i < 4; i++) {
        const p0 = quad[(i + 3) % 4];
        const p1 = quad[i];
        const p2 = quad[(i + 1) % 4];
        const v1x = p0[0] - p1[0], v1y = p0[1] - p1[1];
        const v2x = p2[0] - p1[0], v2y = p2[1] - p1[1];
        const n1 = Math.hypot(v1x, v1y);
        const n2 = Math.hypot(v2x, v2y);
        if (Math.min(n1, n2) < limit) return false;
        const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (n1 * n2)));
        const angle = Math.acos(cos) * 180 / Math.PI;
        if (angle < 38 || angle > 148) return false;
      }
      return true;
    }

    function lineOf(a, b) {
      const vx = b[0] - a[0];
      const vy = b[1] - a[1];
      const n = Math.hypot(vx, vy) + 1e-6;
      return [[a[0], a[1]], [vx / n, vy / n]];
    }

    function signedDistance(point, origin, direction) {
      const dx = point[0] - origin[0];
      const dy = point[1] - origin[1];
      return dx * (-direction[1]) + dy * direction[0];
    }

    function intersect(line1, line2) {
      const origin1 = line1[0], dir1 = line1[1];
      const origin2 = line2[0], dir2 = line2[1];
      const denom = dir1[0] * dir2[1] - dir1[1] * dir2[0];
      if (Math.abs(denom) < 1e-6) return null;
      const t = ((origin2[0] - origin1[0]) * dir2[1] - (origin2[1] - origin1[1]) * dir2[0]) / denom;
      return [origin1[0] + t * dir1[0], origin1[1] + t * dir1[1]];
    }

    function pointsFromMat(mat) {
      const data = mat.data32S;
      const pts = new Array(mat.rows);
      for (let i = 0; i < mat.rows; i++) pts[i] = [data[i * 2], data[i * 2 + 1]];
      return pts;
    }

    function fitLine(samples, distType) {
      const flat = new Float32Array(samples.length * 2);
      for (let i = 0; i < samples.length; i++) {
        flat[i * 2] = samples[i][0];
        flat[i * 2 + 1] = samples[i][1];
      }
      const pts = cv.matFromArray(samples.length, 1, cv.CV_32FC2, flat);
      const line = new cv.Mat();
      try {
        cv.fitLine(pts, line, distType, 0, 0.01, 0.01);
        const d = line.data32F;
        return [[d[2], d[3]], [d[0], d[1]]];
      } finally {
        pts.delete();
        line.delete();
      }
    }

    function resizeMax(image, maxSide) {
      const height = image.rows;
      const width = image.cols;
      const scale = maxSide / Math.max(height, width);
      if (scale >= 1) return [image, 1];
      const dst = new cv.Mat();
      cv.resize(image, dst, new cv.Size(Math.round(width * scale), Math.round(height * scale)), 0, 0, cv.INTER_AREA);
      return [dst, scale];
    }

    function grayOf(image) {
      const ch = image.channels();
      if (ch === 1) return image.clone();
      const gray = new cv.Mat();
      cv.cvtColor(image, gray, ch === 4 ? cv.COLOR_RGBA2GRAY : cv.COLOR_BGR2GRAY);
      return gray;
    }

    function largestMask(blur, percentileValue, blurHist, morphKernel) {
      const width = blur.cols;
      const height = blur.rows;
      const threshold = percentileHist(blurHist, width * height, percentileValue);
      const rawMat = new cv.Mat();
      if (threshold <= 0) {
        rawMat.create(height, width, cv.CV_8UC1);
        rawMat.setTo(new cv.Scalar(255));
      } else {
        cv.threshold(blur, rawMat, Math.ceil(threshold) - 1, 255, cv.THRESH_BINARY);
      }
      const closed = new cv.Mat();
      const opened = new cv.Mat();
      cv.morphologyEx(rawMat, closed, cv.MORPH_CLOSE, morphKernel, new cv.Point(-1, -1), 2);
      cv.morphologyEx(closed, opened, cv.MORPH_OPEN, morphKernel, new cv.Point(-1, -1), 1);
      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();
      cv.findContours(opened, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      let best = null;
      let bestArea = 0;
      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i);
        const area = cv.contourArea(contour);
        if (area > bestArea) {
          if (best) best.delete();
          best = contour;
          bestArea = area;
        } else {
          contour.delete();
        }
      }
      rawMat.delete();
      closed.delete();
      opened.delete();
      hierarchy.delete();
      contours.delete();
      if (!best || bestArea < 0.08 * width * height) {
        if (best) best.delete();
        return null;
      }
      return best;
    }

    function extremeQuad(contour) {
      const hullMat = new cv.Mat();
      cv.convexHull(contour, hullMat, false, true);
      const hull = pointsFromMat(hullMat).map((p) => [p[0], p[1]]);
      hullMat.delete();
      let iMinS = 0, iMaxS = 0, iMinD = 0, iMaxD = 0;
      const sum = (p) => p[0] + p[1];
      const diff = (p) => p[1] - p[0];
      for (let i = 1; i < hull.length; i++) {
        if (sum(hull[i]) < sum(hull[iMinS])) iMinS = i;
        if (sum(hull[i]) > sum(hull[iMaxS])) iMaxS = i;
        if (diff(hull[i]) < diff(hull[iMinD])) iMinD = i;
        if (diff(hull[i]) > diff(hull[iMaxD])) iMaxD = i;
      }
      const quad = orderPoints([hull[iMinS], hull[iMinD], hull[iMaxS], hull[iMaxD]]);
      return [quad, hull];
    }

    function houghSegments(edges, threshold, minLen, maxGap) {
      const lines = new cv.Mat();
      cv.HoughLinesP(edges, lines, 1, Math.PI / 180, threshold, minLen, maxGap);
      const data = lines.data32S;
      const segments = [];
      if (data && data.length >= 4) {
        const count = Math.floor(data.length / 4);
        for (let i = 0; i < count; i++) {
          const a = [data[i * 4], data[i * 4 + 1]];
          const b = [data[i * 4 + 2], data[i * 4 + 3]];
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (len < 1) continue;
          segments.push({
            a, b, len,
            ang: Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI,
            mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
          });
        }
      }
      lines.delete();
      return segments;
    }

    function boundarySegments(gray, contour, precomputedEdges) {
      const height = gray.rows;
      const width = gray.cols;
      const band = Math.max(8, (0.025 * Math.max(height, width)) | 0) | 1;
      const ring = new cv.Mat.zeros(height, width, cv.CV_8UC1);
      const contours = new cv.MatVector();
      contours.push_back(contour);
      cv.drawContours(ring, contours, -1, new cv.Scalar(255), band);
      let edges = precomputedEdges;
      let blurred = null;
      if (!edges) {
        blurred = new cv.Mat();
        cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0);
        edges = new cv.Mat();
        cv.Canny(blurred, edges, 30, 110);
      }
      const kept = new cv.Mat();
      cv.bitwise_and(edges, ring, kept);
      const minLen = (0.07 * Math.max(height, width)) | 0;
      const segments = houghSegments(kept, 30, minLen, (0.03 * Math.max(height, width)) | 0);
      ring.delete(); contours.delete(); kept.delete();
      if (blurred) { blurred.delete(); edges.delete(); }
      return segments;
    }

    function snapQuad(gray, contour, precomputedEdges) {
      const height = gray.rows;
      const width = gray.cols;
      const [initial, hull] = extremeQuad(contour);
      let cx = 0, cy = 0;
      for (const p of hull) { cx += p[0]; cy += p[1]; }
      cx /= hull.length; cy /= hull.length;
      const center = [cx, cy];
      const segments = boundarySegments(gray, contour, precomputedEdges);
      const lines = [];
      const search = 0.1 * Math.max(height, width);
      for (let index = 0; index < 4; index++) {
        const a = initial[index];
        const b = initial[(index + 1) % 4];
        const edgeAngle = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]) + 1e-6;
        let normal = [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (normal[0] * (mid[0] - center[0]) + normal[1] * (mid[1] - center[1]) < 0) {
          normal = [-normal[0], -normal[1]];
        }
        const base = lineOf(a, b);
        const nearby = [];
        for (const segment of segments) {
          if (angDiff(segment.ang, edgeAngle) > 32) continue;
          if (Math.abs(signedDistance(segment.mid, base[0], base[1])) > search) continue;
          const outward = (segment.mid[0] - center[0]) * normal[0] + (segment.mid[1] - center[1]) * normal[1];
          nearby.push([outward, segment]);
        }
        if (!nearby.length) {
          lines.push(base);
          continue;
        }
        nearby.sort((p, q) => q[0] - p[0]);
        const best = nearby[0][1];
        const bestLine = lineOf(best.a, best.b);
        const agree = [best];
        for (const item of nearby) {
          const segment = item[1];
          const same = Math.abs(signedDistance(segment.mid, bestLine[0], bestLine[1])) < 0.02 * Math.max(height, width);
          if (same && angDiff(segment.ang, best.ang) < 12) agree.push(segment);
        }
        const points = [];
        for (const segment of agree) points.push(segment.a, segment.b);
        lines.push(fitLine(points, cv.DIST_L2));
      }
      const corners = [];
      for (let index = 0; index < 4; index++) {
        const corner = intersect(lines[(index + 3) % 4], lines[index]);
        if (!corner) return [initial, initial];
        corners.push(corner);
      }
      const quad = orderPoints(corners);
      if (!validQuad(quad, width, height)) return [initial, initial];
      let moved = 0;
      for (let i = 0; i < 4; i++) moved = Math.max(moved, Math.hypot(quad[i][0] - initial[i][0], quad[i][1] - initial[i][1]));
      if (moved > 0.22 * Math.max(height, width)) return [initial, initial];
      return [quad, initial];
    }

    function longEdgeQuad(contour) {
      const hullMat = new cv.Mat();
      cv.convexHull(contour, hullMat, false, true);
      const hull = pointsFromMat(hullMat);
      hullMat.delete();
      const count = hull.length;
      if (count < 4) return null;
      let perimeter = 0;
      for (let i = 0; i < count; i++) {
        const a = hull[i], b = hull[(i + 1) % count];
        perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
      const minLen = 0.07 * perimeter;
      const segments = [];
      for (let i = 0; i < count; i++) {
        const a = hull[i], b = hull[(i + 1) % count];
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (length < minLen) continue;
        segments.push({
          length,
          angle: Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI,
          a, b,
          mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
        });
      }
      if (segments.length < 4) return null;
      segments.sort((p, q) => q.length - p.length);
      const clusters = [];
      for (const segment of segments) {
        let placed = false;
        for (const cluster of clusters) {
          if (angDiff(segment.angle, cluster.ang) > 18) continue;
          const fitted = fitLine(cluster.pts, cv.DIST_L2);
          const distance = Math.abs(signedDistance(segment.mid, fitted[0], fitted[1]));
          if (distance < 18) {
            cluster.pts.push(segment.a, segment.b);
            cluster.len += segment.length;
            const again = fitLine(cluster.pts, cv.DIST_L2);
            cluster.ang = Math.atan2(again[1][1], again[1][0]) * 180 / Math.PI;
            placed = true;
            break;
          }
        }
        if (!placed) clusters.push({ pts: [segment.a, segment.b], ang: segment.angle, len: segment.length });
      }
      clusters.sort((p, q) => q.len - p.len);
      if (clusters.length < 4) return null;
      const lines = clusters.slice(0, 4).map((cluster) => {
        const fitted = fitLine(cluster.pts, cv.DIST_L2);
        let sx = 0, sy = 0;
        for (const p of cluster.pts) { sx += p[0]; sy += p[1]; }
        fitted.push([sx / cluster.pts.length, sy / cluster.pts.length]);
        return fitted;
      });
      let cx = 0, cy = 0;
      for (const line of lines) { cx += line[2][0]; cy += line[2][1]; }
      cx /= lines.length; cy /= lines.length;
      lines.sort((p, q) => Math.atan2(p[2][1] - cy, p[2][0] - cx) - Math.atan2(q[2][1] - cy, q[2][0] - cx));
      const corners = [];
      for (let i = 0; i < 4; i++) {
        const corner = intersect(lines[i], lines[(i + 1) % 4]);
        if (!corner) return null;
        corners.push(corner);
      }
      return orderPoints(corners);
    }

    function axisDeviation(gray) {
      const blurred = new cv.Mat();
      cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0);
      const edges = new cv.Mat();
      cv.Canny(blurred, edges, 40, 120);
      const segments = houghSegments(edges, 40, 70, 12);
      blurred.delete();
      edges.delete();
      if (segments.length < 4) return 8;
      const lengths = segments.map((s) => s.len);
      const cutoff = percentile(lengths, 40);
      let weight = 0;
      let total = 0;
      for (const segment of segments) {
        if (segment.len < cutoff) continue;
        let angle = Math.abs(segment.ang) % 180;
        const deviation = Math.min(angle, Math.abs(angle - 90), Math.abs(angle - 180));
        total += deviation * segment.len;
        weight += segment.len;
      }
      return weight ? total / weight : 8;
    }

    function borderRoughness(gray) {
      const height = gray.rows;
      const width = gray.cols;
      const band = Math.max(4, (0.04 * height) | 0);
      const strips = [
        gray.rowRange(0, band),
        gray.rowRange(height - band, height),
        gray.colRange(0, band),
        gray.colRange(width - band, width),
      ];
      let worst = 0;
      for (const strip of strips) {
        const lap = new cv.Mat();
        cv.Laplacian(strip, lap, cv.CV_32F);
        const data = lap.data32F;
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += Math.abs(data[i]);
        worst = Math.max(worst, sum / data.length);
        lap.delete();
        strip.delete();
      }
      return worst;
    }

    function outputSize(quad, aspect, outW) {
      let ratio = ASPECTS[aspect];
      outW = Math.max(640, Math.min(4096, outW | 0));
      if (ratio == null) {
        const ordered = orderPoints(quad);
        const top = Math.hypot(ordered[1][0] - ordered[0][0], ordered[1][1] - ordered[0][1]);
        const bottom = Math.hypot(ordered[2][0] - ordered[3][0], ordered[2][1] - ordered[3][1]);
        const left = Math.hypot(ordered[3][0] - ordered[0][0], ordered[3][1] - ordered[0][1]);
        const right = Math.hypot(ordered[2][0] - ordered[1][0], ordered[2][1] - ordered[1][1]);
        ratio = Math.max(top, bottom) / Math.max(1, Math.max(left, right));
        ratio = Math.max(0.5, Math.min(2.4, ratio));
      }
      return [outW, Math.max(1, Math.round(outW / ratio))];
    }

    function expandQuad(quad, ratio) {
      const ordered = orderPoints(quad);
      ratio = Math.max(-0.35, Math.min(0.35, ratio));
      if (Math.abs(ratio) < 1e-6) return ordered;
      const center = [0, 0];
      for (const p of ordered) { center[0] += p[0]; center[1] += p[1]; }
      center[0] /= 4; center[1] /= 4;
      return orderPoints(ordered.map((p) => [
        center[0] + (p[0] - center[0]) * (1 + ratio),
        center[1] + (p[1] - center[1]) * (1 + ratio),
      ]));
    }

    function warpSlide(image, quad, aspect, outW, pad) {
      const expanded = expandQuad(quad, pad || 0);
      const [width, height] = outputSize(expanded, aspect || "16:9", outW || 1920);
      const flat = new Float32Array(8);
      expanded.forEach((p, i) => { flat[i * 2] = p[0]; flat[i * 2 + 1] = p[1]; });
      const src = cv.matFromArray(4, 1, cv.CV_32FC2, flat);
      const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width - 1, 0, width - 1, height - 1, 0, height - 1]);
      const matrix = cv.getPerspectiveTransform(src, dst);
      const out = new cv.Mat();
      const interpolation = Math.max(image.rows, image.cols) > Math.max(width, height) * 1.4 ? cv.INTER_AREA : cv.INTER_CUBIC;
      cv.warpPerspective(
        image, out, matrix, new cv.Size(width, height),
        interpolation, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255),
      );
      src.delete();
      dst.delete();
      matrix.delete();
      return out;
    }

    function candidateScore(gray, quad) {
      if (!validQuad(quad, gray.cols, gray.rows)) return -1e9;
      const warped = warpSlide(gray, quad, "16:9", 640, 0);
      const roughness = borderRoughness(warped);
      const deviation = axisDeviation(warped);
      const areaFrac = shoelace(quad) / (gray.cols * gray.rows);
      warped.delete();
      return -roughness - 14 * deviation + 10 * areaFrac;
    }

    function fitEdgeLine(points, normal, edgeAngle, length) {
      if (points.length < 8) return null;
      let mx = 0, my = 0;
      for (const p of points) { mx += p[0]; my += p[1]; }
      mx /= points.length; my /= points.length;
      const projection = points.map((p) => (p[0] - mx) * normal[0] + (p[1] - my) * normal[1]);
      const cutoff = percentile(projection, 42);
      let outer = points.filter((_, i) => projection[i] >= cutoff);
      if (outer.length < 8) outer = points;
      const band = Math.max(2.6, 0.008 * length);
      function fit(samples) {
        const line = fitLine(samples, cv.DIST_HUBER);
        const angle = Math.atan2(line[1][1], line[1][0]) * 180 / Math.PI;
        if (parallelDiff(angle, edgeAngle) > 14) return [null, []];
        const inliers = samples.filter((point) => Math.abs(signedDistance(point, line[0], line[1])) <= band);
        return [line, inliers];
      }
      let [line, inliers] = fit(outer);
      if (!line) return null;
      if (inliers.length >= 8) {
        const [refined, refinedInliers] = fit(inliers);
        if (refined && refinedInliers.length >= 6) line = refined;
      }
      return line;
    }

    function sampleAt(gray, x, y) {
      const width = gray.cols;
      const height = gray.rows;
      if (x < 1 || y < 1 || x > width - 2 || y > height - 2) return 0;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const x1 = Math.min(x0 + 1, width - 1);
      const y1 = Math.min(y0 + 1, height - 1);
      const dx = x - x0;
      const dy = y - y0;
      const data = gray.data;
      const i00 = data[y0 * width + x0];
      const i10 = data[y0 * width + x1];
      const i01 = data[y1 * width + x0];
      const i11 = data[y1 * width + x1];
      return (i00 * (1 - dx) + i10 * dx) * (1 - dy) + (i01 * (1 - dx) + i11 * dx) * dy;
    }

    function calibrate(gray, quad) {
      const height = gray.rows;
      const width = gray.cols;
      quad = orderPoints(quad);
      if (!validQuad(quad, width, height)) return quad;
      const center = [0, 0];
      for (const p of quad) { center[0] += p[0]; center[1] += p[1]; }
      center[0] /= 4; center[1] /= 4;
      const mask = cv.Mat.zeros(height, width, cv.CV_8UC1);
      const poly = cv.matFromArray(4, 1, cv.CV_32SC2, quad.map((p) => [Math.round(p[0]), Math.round(p[1])]).flat());
      const contours = new cv.MatVector();
      contours.push_back(poly);
      cv.fillPoly(mask, contours, new cv.Scalar(255));
      const core = mask.clone();
      cv.polylines(core, contours, true, new cv.Scalar(0), 31);
      const maskData = mask.data;
      const coreData = core.data;
      const grayData = gray.data;
      const coreHist = new Uint32Array(256);
      let coreCount = 0;
      for (let i = 0; i < coreData.length; i++) {
        if (coreData[i]) {
          coreHist[grayData[i]]++;
          coreCount++;
        }
      }
      let hist = coreHist;
      let count = coreCount;
      if (coreCount <= 50) {
        hist = new Uint32Array(256);
        count = 0;
        for (let i = 0; i < maskData.length; i++) {
          if (maskData[i]) {
            hist[grayData[i]]++;
            count++;
          }
        }
      }
      poly.delete(); contours.delete(); core.delete(); mask.delete();
      if (count < 20) return quad;
      const brightFloor = Math.max(130, percentileHist(hist, count, 40) * 0.72);
      const lines = [];
      for (let index = 0; index < 4; index++) {
        const start = quad[index];
        const end = quad[(index + 1) % 4];
        const length = Math.hypot(end[0] - start[0], end[1] - start[1]) + 1e-6;
        const tangent = [(end[0] - start[0]) / length, (end[1] - start[1]) / length];
        let normal = [-tangent[1], tangent[0]];
        const mid = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
        if (normal[0] * (mid[0] - center[0]) + normal[1] * (mid[1] - center[1]) < 0) normal = [-normal[0], -normal[1]];
        const fallback = lineOf(start, end);
        const offsets = linspace(-0.26 * length, 0.12 * length, 110);
        const step = offsets[1] - offsets[0];
        const sustain = Math.max(4, Math.round(12 / Math.max(step, 1)));
        const span = Math.max(3, Math.round(9 / Math.max(step, 1)));
        const points = [];
        const stations = linspace(0.04, 0.96, 52);
        for (let s = 0; s < stations.length; s++) {
          const t = stations[s];
          const base = [start[0] * (1 - t) + end[0] * t, start[1] * (1 - t) + end[1] * t];
          const samples = new Float64Array(offsets.length);
          for (let k = 0; k < offsets.length; k++) {
            samples[k] = sampleAt(gray, base[0] + offsets[k] * normal[0], base[1] + offsets[k] * normal[1]);
          }
          let chosen = -1;
          for (let idx = sustain + 1; idx < samples.length - span - 1; idx++) {
            const inward = medianRange(samples, idx - sustain, idx);
            const outward = medianRange(samples, idx + 1, idx + 1 + span);
            if (inward < brightFloor || outward > 85) continue;
            if (inward - outward < 55) continue;
            chosen = idx;
          }
          if (chosen >= 0) points.push([base[0] + offsets[chosen] * normal[0], base[1] + offsets[chosen] * normal[1]]);
        }
        const edgeAngle = Math.atan2(tangent[1], tangent[0]) * 180 / Math.PI;
        const fitted = points.length ? fitEdgeLine(points, normal, edgeAngle, length) : null;
        if (!fitted) {
          lines.push(fallback);
          continue;
        }
        const shift = (fitted[0][0] - mid[0]) * normal[0] + (fitted[0][1] - mid[1]) * normal[1];
        if (Math.abs(shift) > 0.12 * Math.max(height, width)) {
          lines.push(fallback);
          continue;
        }
        const nudge = Math.max(1.8, 0.008 * length);
        lines.push([[fitted[0][0] + normal[0] * nudge, fitted[0][1] + normal[1] * nudge], fitted[1]]);
      }
      const corners = [];
      for (let index = 0; index < 4; index++) {
        const corner = intersect(lines[(index + 3) % 4], lines[index]);
        if (!corner) return quad;
        corners.push(corner);
      }
      const refined = orderPoints(corners);
      if (!validQuad(refined, width, height)) return quad;
      let moved = 0;
      for (let i = 0; i < 4; i++) moved = Math.max(moved, Math.hypot(refined[i][0] - quad[i][0], refined[i][1] - quad[i][1]));
      if (moved > 0.18 * Math.max(height, width)) return quad;
      return refined;
    }

    function isDuplicateQuad(quad, seen) {
      const ordered = orderPoints(quad);
      for (const prev of seen) {
        let maxD = 0;
        for (let i = 0; i < 4; i++) {
          const d = Math.hypot(ordered[i][0] - prev[i][0], ordered[i][1] - prev[i][1]);
          if (d > maxD) maxD = d;
        }
        if (maxD < 3) return true;
      }
      seen.push(ordered);
      return false;
    }

    function detectQuad(image) {
      const fullH = image.rows;
      const fullW = image.cols;
      const [small, scale] = resizeMax(image, 1100);
      const owned = small !== image ? [small] : [];
      try {
        const gray = grayOf(small);
        owned.push(gray);
        const lab = new cv.Mat();
        if (small.channels() === 4) {
          const rgb = new cv.Mat();
          cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
          cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
          rgb.delete();
        } else {
          cv.cvtColor(small, lab, cv.COLOR_BGR2Lab);
        }
        owned.push(lab);
        const labData = lab.data;
        const ldata = new Uint8Array(lab.rows * lab.cols);
        for (let i = 0; i < ldata.length; i++) ldata[i] = labData[i * lab.channels()];
        const luminance = cv.matFromArray(lab.rows, lab.cols, cv.CV_8UC1, ldata);
        owned.push(luminance);
        const blur = new cv.Mat();
        const sigma = Math.max(3, 0.012 * Math.max(gray.rows, gray.cols));
        cv.GaussianBlur(luminance, blur, new cv.Size(0, 0), sigma, sigma);
        owned.push(blur);
        const blurHist = new Uint32Array(256);
        const blurData = blur.data;
        for (let i = 0; i < blurData.length; i++) blurHist[blurData[i]]++;
        const kernelSize = Math.max(5, Math.round(0.012 * Math.max(gray.cols, gray.rows)) | 1);
        const morphKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kernelSize, kernelSize));
        owned.push(morphKernel);
        const blurredGray = new cv.Mat();
        cv.GaussianBlur(gray, blurredGray, new cv.Size(3, 3), 0);
        owned.push(blurredGray);
        const cannyEdges = new cv.Mat();
        cv.Canny(blurredGray, cannyEdges, 30, 110);
        owned.push(cannyEdges);
        let bestQuad = null;
        let bestScore = -1e9;
        const seen = [];
        for (const level of [46, 50, 54, 58, 62, 66, 72]) {
          const contour = largestMask(blur, level, blurHist, morphKernel);
          if (!contour) continue;
          try {
            const [snapped, initial] = snapQuad(gray, contour, cannyEdges);
            const candidates = [snapped, initial, longEdgeQuad(contour)];
            for (const quad of candidates) {
              if (!quad || isDuplicateQuad(quad, seen)) continue;
              const score = candidateScore(gray, quad);
              if (score > bestScore) {
                bestScore = score;
                bestQuad = quad;
              }
            }
          } finally {
            contour.delete();
          }
        }
        if (!bestQuad) {
          const width = gray.cols;
          const height = gray.rows;
          bestQuad = [
            [0.15 * width, 0.18 * height],
            [0.85 * width, 0.18 * height],
            [0.85 * width, 0.82 * height],
            [0.15 * width, 0.82 * height],
          ];
          bestScore = -80;
        } else {
          bestQuad = calibrate(gray, orderPoints(bestQuad));
        }
        const fullQuad = orderPoints(bestQuad.map((p) => [p[0] / scale, p[1] / scale]));
        for (const p of fullQuad) {
          p[0] = Math.max(0, Math.min(fullW - 1, p[0]));
          p[1] = Math.max(0, Math.min(fullH - 1, p[1]));
        }
        const confidence = Math.max(0, Math.min(1, (bestScore + 55) / 45));
        return { corners: fullQuad, confidence };
      } finally {
        for (const mat of owned) mat.delete();
      }
    }

    function bgrToRgba(bgr) {
      const rgba = new cv.Mat();
      cv.cvtColor(bgr, rgba, cv.COLOR_BGR2RGBA);
      const copy = new Uint8ClampedArray(rgba.data);
      const width = rgba.cols;
      const height = rgba.rows;
      rgba.delete();
      return { data: copy, width, height };
    }

    return { detectQuad, warpSlide, bgrToRgba, orderPoints, ASPECTS };
  }

  return { create };
});
