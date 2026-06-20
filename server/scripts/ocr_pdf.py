"""
ocr_pdf.py — EasyOCR extraction for Boundary.IQ
=================================================

FIX #6: Re-architected from a one-shot subprocess script to a persistent
stdin-based daemon so the EasyOCR model (~100 MB) is loaded exactly once
per process lifetime instead of once per document call.

Two operating modes
-------------------
DAEMON mode  (default, used by the Node server):
  The process reads newline-delimited JSON job descriptors from stdin,
  processes each one, and writes a newline-delimited JSON result to stdout.
  The EasyOCR Reader is initialised on first use and kept alive.

  Input line:  { "path": "/abs/path/to/file.pdf", "id": "optional-job-id" }
  Output line: { "id": "...", "text": "...", "error": null }
              or { "id": "...", "text": null, "error": "message" }

  Send the special sentinel  { "exit": true }  to cleanly shut the daemon down.

ONE-SHOT mode  (legacy, for direct CLI use):
  Pass --oneshot as the first argument, then the PDF/image path.
  Behaviour is identical to the original script: text is printed to stdout
  and the process exits.

  Usage:  python ocr_pdf.py --oneshot <pdf_path>
"""

import sys
import os
import json
import tempfile
import subprocess
import glob

_reader = None  # module-level singleton — loaded once


def _get_reader():
    """Return the shared EasyOCR reader, initialising it on first call."""
    global _reader
    if _reader is None:
        import easyocr  # lazy import so import errors surface at call time
        _reader = easyocr.Reader(['en'], gpu=False)
    return _reader


def _ocr_file(file_path: str, max_pages: int = 10) -> str:
    """
    Run OCR on *file_path* (PDF or image) and return the extracted text.
    Raises on unexpected errors; returns empty string if no pages found.
    """
    ext = os.path.splitext(file_path)[1].lower()

    if ext in ('.png', '.jpg', '.jpeg', '.webp', '.gif', '.tiff', '.tif', '.bmp'):
        results = _get_reader().readtext(file_path, detail=0)
        return '\n'.join(results)

    # PDF → convert up to max_pages pages to PNG, then OCR each
    with tempfile.TemporaryDirectory() as tmp:
        prefix = os.path.join(tmp, 'page')
        subprocess.run(
            ['pdftoppm', '-png', '-r', '150', '-f', '1', '-l', str(max_pages),
             file_path, prefix],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        pngs = sorted(
            glob.glob(os.path.join(tmp, 'page-*.png')),
            key=lambda x: int(os.path.basename(x).split('-')[1].split('.')[0])
        )
        if not pngs:
            return ''

        reader = _get_reader()
        parts = []
        for png in pngs:
            page_num = os.path.basename(png).split('-')[1].split('.')[0]
            page_text = '\n'.join(reader.readtext(png, detail=0))
            parts.append(f'--- PAGE {page_num} TEXT ---\n{page_text}')
        return '\n\n'.join(parts)


# ─── Daemon mode ──────────────────────────────────────────────────────────────

def run_daemon():
    """
    Read newline-delimited JSON job descriptors from stdin, OCR each file,
    and write newline-delimited JSON results to stdout.

    Keeps the EasyOCR model loaded for the lifetime of the process, which
    avoids the ~100 MB cold-start overhead on every document call.

    Job descriptor fields:
      path     (str, required)  Absolute path to PDF or image
      id       (str, optional)  Correlation ID echoed back in result
      maxPages (int, optional)  Override page limit for pdftoppm (default 10)
      exit     (bool, optional) Send true to cleanly shut down the daemon
    """
    print(json.dumps({'status': 'ready'}), flush=True)

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue

        try:
            job = json.loads(raw_line)
        except json.JSONDecodeError as e:
            print(json.dumps({'id': None, 'text': None,
                              'error': f'Invalid JSON: {e}'}), flush=True)
            continue

        if job.get('exit'):
            break

        job_id   = job.get('id')
        file_path = job.get('path', '')
        max_pages = int(job.get('maxPages', 10))

        if not file_path or not os.path.exists(file_path):
            print(json.dumps({'id': job_id, 'text': None,
                              'error': f'File not found: {file_path}'}),
                  flush=True)
            continue

        try:
            text = _ocr_file(file_path, max_pages=max_pages)
            print(json.dumps({'id': job_id, 'text': text, 'error': None}),
                  flush=True)
        except Exception as e:
            print(json.dumps({'id': job_id, 'text': None, 'error': str(e)}),
                  flush=True)


# ─── One-shot (legacy CLI) mode ───────────────────────────────────────────────

def run_oneshot(file_path: str):
    """Original one-shot behaviour: print text, exit."""
    if not os.path.exists(file_path):
        print(f'Error: file not found: {file_path}', file=sys.stderr)
        sys.exit(1)
    try:
        text = _ocr_file(file_path)
        print(text)
    except Exception as e:
        print(f'OCR PDF Error: {e}', file=sys.stderr)
        sys.exit(2)


# ─── Entry point ─────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) >= 2 and sys.argv[1] == '--oneshot':
        if len(sys.argv) < 3:
            print('Usage: python ocr_pdf.py --oneshot <pdf_path>', file=sys.stderr)
            sys.exit(1)
        run_oneshot(sys.argv[2])
    else:
        # Daemon mode: stdin-driven, model loaded once
        run_daemon()


if __name__ == '__main__':
    main()
