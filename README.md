**English** | [简体中文](README.zh-CN.md)

# slide-photo-pdf

Turn photos of a projected slide into frontal pages, then join them into one PDF. The page runs entirely in your browser. Photos are not uploaded.

You usually take these pictures from a seat. The screen is skewed, and a speaker or the podium may cover a corner. Open the page, check the red box, and download one PDF. After the page and its libraries have loaded, that visit keeps working if the network drops.

## Run it

The page cannot be opened by double-clicking `index.html`. The browser blocks the detection library when it is loaded from a local file. Serve the folder over HTTP instead.

Python 3 is enough. No packages need to be installed.

```bash
./serve.sh
```

Then open http://127.0.0.1:8766/ .

```bash
HOST=127.0.0.1 PORT=8766 ./serve.sh
```

- `127.0.0.1` accepts connections only from this computer. This is the default.
- `0.0.0.0` or an address such as `192.168.1.20` lets other machines open the page. Only the HTML, scripts, and libraries are transferred. The photos stay in the browser that opened the page.

The first load fetches OpenCV and the HEIC decoder, about 15 MB. Refresh after that is a normal page load from the server you started.

## What you can do

- Add JPEG, PNG, WEBP, BMP, and HEIC photos with no hard page limit (memory depends on your device).
- Drag a corner, or drag the middle of an edge to move that whole side. A magnifier follows the pointer.
- Tighten or loosen every box together. The middle of the slider is the detected crop. The two ends are about 6% tighter and 6% wider.
- Choose 16:9, 4:3, 16:10, 3:2, or the detected edge lengths. Output width can be 1280, 1920, or 2560.
- Click a preview to inspect that page. Reverse the order when a phone album listed the newest photo first.
- Name the export and download either a PDF or a vertically stitched long JPEG image. The default base name is `会议PPT`.
- Remove every photo at once and start another batch.

A light at the top right shows the state: red while the libraries load, blue while photos are read, purple while a page is being calculated, and green when the page is ready. The switch next to it changes between day and night.

## How a slide is found

The same detector as the earlier Python version now runs in the browser through OpenCV.js. It does not trust one guess at the four corners.

1. The photo is reduced until its long side is about 1100 pixels. Several brightness thresholds each pick out the largest bright region.
2. Each region becomes one or more quadrilaterals.
3. Candidates are warped to a temporary 16:9 page and scored. A border that cuts through text, or a page that is still skewed, scores worse.
4. Each side of the winning box is scanned from the bright interior toward the darker room. The four corners are the intersections of those edges, so a hidden corner can still be placed when both edges are partly visible.

The exported page is a perspective warp of the original photo. JPEG pages are embedded in one PDF, which is built in the browser.

## What is in this repository

| Path | Role |
|---|---|
| `index.html`, `app.js` | The page |
| `detect.js` | Finding the quadrilateral, warping, and the PDF writer |
| `vendor/` | OpenCV.js and the HEIC decoder used by the page |
| `serve.sh` | Serves this folder over HTTP |
| `backup/` | The previous Python server version |

## Limits

- Content hidden by a person or a podium cannot be recovered.
- A dark slide, a screen about as bright as the wall, or a large white panel on the slide can make the box follow the wrong rectangle.
- If people cover most of one edge, that edge may tilt across the slide. Drag it back.
- Warping a large phone photo is slower than the Python version, and many full-size photos can run out of memory on a phone.
- HEIC is decoded in the browser. JPEG, PNG, and WEBP are the safer formats if a particular HEIC file fails.

## Third-party code

- `vendor/opencv.js` is OpenCV, Apache-2.0, from `@techstark/opencv-js` 5.0.0-release.1.
- `vendor/libheif.js` and `vendor/libheif.wasm` are libheif-js 1.19.8, LGPL-3.0.

## License

MIT. See [LICENSE](LICENSE).
