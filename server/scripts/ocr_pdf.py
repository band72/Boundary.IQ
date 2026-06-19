import sys
import os
import tempfile
import subprocess
import glob
import easyocr

def main():
    if len(sys.argv) < 2:
        print("Usage: python ocr_pdf.py <pdf_path>", file=sys.stderr)
        sys.exit(1)

    pdf_path = sys.argv[1]
    if not os.path.exists(pdf_path):
        print(f"Error: file not found: {pdf_path}", file=sys.stderr)
        sys.exit(1)

    try:
        ext = os.path.splitext(pdf_path)[1].lower()
        if ext in ['.png', '.jpg', '.jpeg', '.webp', '.gif']:
            # For images, read directly using EasyOCR
            reader = easyocr.Reader(['en'], gpu=False)
            results = reader.readtext(pdf_path, detail=0)
            print("\n".join(results))
            return

        # Create a temp directory for PDF page conversion
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_prefix = os.path.join(temp_dir, 'page')
            
            # Run pdftoppm to convert first 10 pages to PNG
            subprocess.run([
                'pdftoppm', '-png', '-r', '150', '-f', '1', '-l', '10',
                pdf_path, temp_prefix
            ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            
            # Find all generated png files and sort them numerically
            png_files = glob.glob(os.path.join(temp_dir, 'page-*.png'))
            png_files.sort(key=lambda x: int(os.path.basename(x).split('-')[1].split('.')[0]))
            
            if not png_files:
                print("Warning: no pages extracted from PDF.", file=sys.stderr)
                sys.exit(0)
                
            # Initialize easyocr reader (gpu=False to avoid CUDA conflicts)
            reader = easyocr.Reader(['en'], gpu=False)
            
            full_text = []
            for png_path in png_files:
                page_num = os.path.basename(png_path).split('-')[1].split('.')[0]
                results = reader.readtext(png_path, detail=0)
                page_text = "\n".join(results)
                full_text.append(f"--- PAGE {page_num} TEXT ---\n" + page_text)
                
            print("\n\n".join(full_text))
            
    except Exception as e:
        print(f"OCR PDF Error: {e}", file=sys.stderr)
        sys.exit(2)

if __name__ == '__main__':
    main()
