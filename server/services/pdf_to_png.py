import sys
import os
import fitz # PyMuPDF

def main():
    if len(sys.argv) < 5:
        print("Usage: python pdf_to_png.py <pdf_path> <png_prefix> <dpi> <max_pages> [single_file]", file=sys.stderr)
        sys.exit(1)
        
    pdf_path = sys.argv[1]
    png_prefix = sys.argv[2]
    try:
        dpi = int(sys.argv[3])
    except ValueError:
        dpi = 150
    try:
        max_pages = int(sys.argv[4])
    except ValueError:
        max_pages = 5
        
    single_file = len(sys.argv) > 5 and sys.argv[5].lower() == 'true'

    try:
        doc = fitz.open(pdf_path)
        num_pages = len(doc)
        pages_to_convert = min(num_pages, max_pages) if max_pages > 0 else num_pages
        
        if single_file:
            page = doc.load_page(0)
            pix = page.get_pixmap(dpi=dpi)
            output_path = f"{png_prefix}.png"
            pix.save(output_path)
            print(f"Saved single page to {output_path}")
        else:
            for i in range(pages_to_convert):
                page = doc.load_page(i)
                pix = page.get_pixmap(dpi=dpi)
                page_num_str = f"{i+1:02d}" if (pages_to_convert >= 10 or num_pages >= 10) else f"{i+1}"
                output_path = f"{png_prefix}-{page_num_str}.png"
                pix.save(output_path)
                print(f"Saved page {i+1} to {output_path}")
        
    except Exception as e:
        print(f"PDF to PNG conversion error: {e}", file=sys.stderr)
        sys.exit(2)

if __name__ == '__main__':
    main()
