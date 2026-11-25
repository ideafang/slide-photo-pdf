**English** | [简体中文](README.zh-CN.md)

# slide-photo-pdf

Turn photos of a projected slide into frontal pages, then join them into one PDF.

You usually take these pictures from a seat. The screen is skewed, a speaker or the podium may cover a corner, and a phone album often lists the newest photo first. This tool finds the slide, lets you correct the box, and exports one file. It runs on your own computer. Uploaded photos stay in memory and are discarded when you refresh or close the page.

## What it does

- Accepts JPEG, PNG, HEIC, WEBP, BMP, and TIFF. You can add up to 30 photos in one session, and one upload is limited to 250 MB.
- Draws a red quadrilateral on each photo. Drag a corner to move that corner, or drag the midpoint of an edge to shift the whole side. A magnifier follows the pointer and does not stretch past the photo.
- Tightens or loosens every box together. The middle of the slider is the detected crop. The two ends are about 6% tighter and 6% wider.
- Sets the page shape to 16:9, 4:3, 16:10, 3:2, or the lengths of the detected edges. Recent projectors are usually 16:9. The output width can be 1280, 1920, or 2560; that only changes how sharp the PDF is.
- Shows the frontal page beside the photo. On a phone, the preview is below the photo. Click the preview to inspect it at full output resolution.
- Reverses the page order in one step, for albums that list the newest photo first.
- Names the PDF and downloads it. The default name is `会议PPT.pdf`. On iPhone Safari the result is a normal file link, so you can save it to Files.
- Marks a page when the automatic box looks unreliable, so you know to check the four corners before exporting.

## How a slide is found

A corner is often hidden, so the tool does not trust one guess at the four corners. It looks for the screen edges and places each corner where two edges meet.

1. The photo is reduced until its long side is about 1100 pixels. Several brightness thresholds each pick out the largest bright region. A projected slide is usually that region, but a white card inside the slide can be bright as well.
2. Each region becomes one or more quadrilaterals: one snapped to nearby straight edges, one built from the long sides of the outline, and one from the outermost points.
3. Every candidate is warped to a temporary 16:9 page and scored. A border that cuts through text looks rough and scores worse. A page that is still skewed scores worse. A larger box gets a small bonus.
4. Around the winning box, each side is scanned from the bright interior toward the darker room. The drop from bright to dark is fitted with a straight line. The four corners are the intersections of those lines. If a corner itself is behind a person, the visible parts of the two edges can still determine it.
5. If no bright region is usable, the tool falls back to a rectangle inset from the photo and marks that page as unreliable.

The page you export is a perspective warp of the original photo onto the shape and width you chose. Padding widens or tightens the box around its center before that warp. Pixels that fall outside the photo are filled with white. Each page is stored as a JPEG inside one PDF.

The command-line tool uses the same detection and warp. It does not open the editor, so check a low confidence value by looking at the printed corners or the images written with `--debug-dir`.

## What is in this repository

| File | Role |
|---|---|
| `index.html` | The page: upload, adjustment, preview, and download |
| `app.py` | Local server. Sessions and finished PDFs are kept in memory |
| `detect.py` | Finding the quadrilateral, warping a page, and writing the PDF |
| `run.sh` | Starts the server with `python3` |

There is no account and no separate database. Closing the page asks the server to drop that session. A finished PDF stays available at its download link for about 10 minutes.

## Install and run

Python 3.10 or newer.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 app.py
```

`./run.sh` does the same thing. Open http://127.0.0.1:8765/ .

The default bind address is `127.0.0.1` and the default port is `8765`.

```bash
python3 app.py --host 127.0.0.1 --port 8765
HOST=127.0.0.1 PORT=8765 ./run.sh
```

- `127.0.0.1` accepts connections only from this computer.
- `0.0.0.0` or `*` listens on every interface. Anyone who can reach the machine can open the page. Uploaded photos then sit in that machine's memory until the page is closed or the server stops. Do not publish this on the open internet unless you add your own access control.
- An address such as `192.168.1.20` listens only on that interface.

## Command line

```bash
python3 detect.py photo1.HEIC photo2.JPG -o slides.pdf
```

- `--aspect` is `16:9`, `4:3`, `16:10`, `3:2`, or `free`. The default is `16:9`.
- `--width` is the page width in pixels, from 640 to 4096. The default is 1920.
- `--pad 0.02` widens the box by 2% around its center. `--pad -0.02` tightens it. Values are limited to ±0.35.
- `--debug-dir out` writes a copy of each photo with the detected box, and the warped page, into `out`.

## Limits

- Content hidden by a person or a podium cannot be recovered. Only the screen edges that are still visible can set the box.
- A dark slide, a screen about as bright as the wall, or a large white panel on the slide can make the box follow the wrong rectangle.
- If people cover most of one edge, that edge may tilt across the slide. Drag it back; the slider only scales the whole box.
- Refreshing or closing the page discards the photos. If a download link has expired, generate the PDF again.
- This is a local tool, not a hosted conversion service.

## License

MIT. See [LICENSE](LICENSE).
