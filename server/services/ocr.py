import sys
import easyocr

def main():
    if len(sys.argv) < 2:
        print("Usage: python ocr.py <image_path>", file=sys.stderr)
        sys.exit(1)
        
    image_path = sys.argv[1]
    
    try:
        # Initialize English reader (gpu=True automatically uses CUDA if available, fallback to CPU)
        reader = easyocr.Reader(['en'], gpu=True)
        
        # Read text details=0 returns only the raw text strings
        results = reader.readtext(image_path, detail=0)
        
        # Output results to stdout
        print("\n".join(results))
    except Exception as e:
        print(f"OCR Error: {e}", file=sys.stderr)
        sys.exit(2)

if __name__ == '__main__':
    main()
