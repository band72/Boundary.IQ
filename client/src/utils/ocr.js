/**
 * Utility to load Tesseract.js and PDF.js dynamically,
 * and perform OCR on files directly in the browser (client-side).
 */

function loadScript(url) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${url}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = url;
    script.onload = () => resolve();
    script.onerror = (err) => reject(new Error(`Failed to load script: ${url}`));
    document.head.appendChild(script);
  });
}

export async function loadOcrLibraries() {
  // Load PDF.js first if not loaded
  if (!window.pdfjsLib) {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  // Load Tesseract.js if not loaded
  if (!window.Tesseract) {
    await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.0.3/dist/tesseract.min.js');
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
