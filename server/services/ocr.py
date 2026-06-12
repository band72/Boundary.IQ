import sys
import easyocr

# Force UTF-8 encoding on stdout and stderr to avoid Windows code-page (charmap) encoding crashes
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

def main():
    if len(sys.argv) < 2:
        print("Usage: python ocr.py <image_path>", file=sys.stderr)
        sys.exit(1)
        
    image_path = sys.argv[1]
    
    try:
        # Initialize English reader (gpu=False runs on CPU to prevent CUDA OOM when running gemma4:26b)
        reader = easyocr.Reader(['en'], gpu=False)
        
        # Read text details=0 returns only the raw text strings
        results = reader.readtext(image_path, detail=0)
        
        # Output results to stdout
        print("\n".join(results))
    except Exception as e:
        print(f"OCR Error: {e}", file=sys.stderr)
        sys.exit(2)

if __name__ == '__main__':
    main()
