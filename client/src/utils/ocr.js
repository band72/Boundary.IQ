/**
 * Utility to load Tesseract.js and PDF.js dynamically,
 * and perform OCR on files directly in the browser (client-side).
 *
 * Security: Both CDN scripts are loaded with SRI (Subresource Integrity) hashes
 * and crossOrigin="anonymous" so that a compromised CDN cannot inject malicious code.
 */

function loadScript(url, integrity) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${url}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = url;
    script.crossOrigin = 'anonymous';
    if (integrity) script.integrity = integrity;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script: ${url}`));
    document.head.appendChild(script);
  });
}

// Pinned SRI hashes — re-compute when upgrading CDN versions:
//   python3 -c "import urllib.request,hashlib,base64; d=urllib.request.urlopen('<url>').read(); print('sha384-'+base64.b64encode(hashlib.sha384(d).digest()).decode())"
const CDN = {
  pdfJs:       { url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',        sri: 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e' },
  pdfWorker:   { url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js', sri: 'sha384-SnzOobpRMLXZ52iJvZm/C0fYw0OQemTXzTjIsdsfMcrCtCEe9qgzxTd3RSklO5x2' },
  tesseract:   { url: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.0.3/dist/tesseract.min.js',    sri: 'sha384-PLsnF3AeZtWBxD7GdeSo28q0iYlgh0mqvDxTVwdOb5ouGKhOHJAAIRGaTHORQEAr' },
};

export async function loadOcrLibraries() {
  // Load PDF.js first if not loaded
  if (!window.pdfjsLib) {
    await loadScript(CDN.pdfJs.url, CDN.pdfJs.sri);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = CDN.pdfWorker.url;
  }
  // Load Tesseract.js if not loaded
  if (!window.Tesseract) {
    await loadScript(CDN.tesseract.url, CDN.tesseract.sri);
  }
}

export async function performFrontendOcr(file, onProgress) {
  await loadOcrLibraries();
  
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  
  if (isPdf) {
    if (onProgress) onProgress(`Loading PDF: ${file.name}...`);
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    
    let combinedText = '';
    const maxPages = Math.min(pdf.numPages, 10);
    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      if (onProgress) onProgress(`OCR Page ${pageNum}/${maxPages} for ${file.name}...`);
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const context = canvas.getContext('2d');
      
      await page.render({ canvasContext: context, viewport }).promise;
      
      const { data: { text } } = await window.Tesseract.recognize(canvas, 'eng');
      if (text && text.trim().length > 5) {
        combinedText += `\n\n--- PAGE ${pageNum} LEGAL DESCRIPTION ---\n${text}`;
      }
    }
    return combinedText;
  } else {
    // Image file
    if (onProgress) onProgress(`OCR processing image: ${file.name}...`);
    const { data: { text } } = await window.Tesseract.recognize(file, 'eng');
    return text;
  }
}
