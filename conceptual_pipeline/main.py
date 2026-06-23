import os
import sys
import json
import argparse
from dotenv import load_dotenv

# Add current directory to path to allow importing local modules
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

import cogo
import parser
import comfy_client

# Load environment variables if a .env file exists in root
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '../.env'))

DEFAULT_DEED_TEXT = (
    "A PART OF SECTION 8, TOWNSHIP 7 SOUTH, RANGE 27 EAST, CLAY COUNTY, FLORIDA: "
    "COMMENCING AT THE SOUTHWESTERLY CORNER OF SAID SECTION 8; "
    "THENCE N.13º29’15”W 937.78 FEET TO THE POINT OF BEGINNING; "
    "THENCE CONTINUE N.13º29’15”W 105.05 FEET; "
    "THENCE N.89º05’20”E 471.00 FEET MORE OR LESS; "
    "THENCE SOUTHEASTERLY ALONG THE ST. JOHNS RIVER CHORD S.33º36’00”E 121.82 FEET; "
    "THENCE S.89º05’20”W 514.00 FEET MORE OR LESS TO THE POINT OF BEGINNING."
)

MOCK_DEED_COURSES = [
    {"type": "Line", "bearing": "N 13°29'15\" W", "distance": 105.05},
    {"type": "Line", "bearing": "N 89°05'20\" E", "distance": 471.00},
    {"type": "Line", "bearing": "S 33°36'00\" E", "distance": 121.82},
    {"type": "Line", "bearing": "S 89°05'20\" W", "distance": 514.00}
]

def generate_svg_map(vertices, courses, acreage, misclosure, course_metadata, output_path):
    """
    Generates a beautiful dark-themed SVG map of the boundary traverse.
    This acts as a reliable vector visual output.
    """
    import math
    import os

    xs = [v[0] for v in vertices]
    ys = [v[1] for v in vertices]
    
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    
    width = max_x - min_x
    height = max_y - min_y
    
    # Avoid division by zero for straight-line boundaries
    if width == 0: width = 1.0
    if height == 0: height = 1.0
    
    svg_w = 1200
    svg_h = 800
    
    # Grid/Border Box definition
    box_x1 = 25
    box_y1 = 80
    box_w = 775
    box_h = 695
    padding = 110
    
    # Scale factor to fit inside SVG canvas left drawing area
    scale_x = (box_w - 2 * padding) / width
    scale_y = (box_h - 2 * padding) / height
    scale = min(scale_x, scale_y)
    
    # Center the drawing inside the box
    offset_x = box_x1 + padding + (box_w - 2 * padding - width * scale) / 2
    offset_y = box_y1 + padding + (box_h - 2 * padding - height * scale) / 2
    
    def transform(x, y):
        tx = offset_x + (x - min_x) * scale
        # Flip Y coordinates: in SVG space, Y increases downwards, so min Cartesian Y corresponds to max SVG Y in the box
        ty = box_y1 + padding + (box_h - 2 * padding - height * scale) / 2 + (height * scale - (y - min_y) * scale)
        return tx, ty
        
    svg_points = []
    for x, y in vertices:
        tx, ty = transform(x, y)
        svg_points.append(f"{tx},{ty}")
        
    points_str = " ".join(svg_points)
    
    # Extract parcel name from path to display in the header
    base = os.path.basename(output_path)
    parcel_name = base.replace("_conceptual_map.svg", "").replace("_conceptual_map", "").replace("Conceptual_Map.svg", "MAP").replace(".svg", "").upper()
    
    # Header grid and background
    svg_content = f"""<svg width="{svg_w}" height="{svg_h}" viewBox="0 0 {svg_w} {svg_h}" xmlns="http://www.w3.org/2000/svg">
  <!-- Premium Dark Theme -->
  <rect width="100%" height="100%" fill="#0d1117" />
  
  <defs>
    <!-- Background Grids -->
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#21262d" stroke-width="1" />
    </pattern>
    <pattern id="subgrid" width="8" height="8" patternUnits="userSpaceOnUse">
      <path d="M 8 0 L 0 0 0 8" fill="none" stroke="#161b22" stroke-width="0.5" />
    </pattern>
    <!-- Soft Glow Filter -->
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="3" result="blur" />
      <feComposite in="SourceGraphic" in2="blur" operator="over" />
    </filter>
  </defs>
  
  <rect width="100%" height="100%" fill="url(#subgrid)" />
  <rect width="100%" height="100%" fill="url(#grid)" />
  
  <!-- Outer double border frame -->
  <rect x="20" y="20" width="1160" height="760" fill="none" stroke="#30363d" stroke-width="1.5" />
  <rect x="25" y="25" width="1150" height="750" fill="none" stroke="#58a6ff" stroke-width="1.5" />
  
  <!-- Header horizontal divider -->
  <line x1="25" y1="80" x2="1175" y2="80" stroke="#58a6ff" stroke-width="1.5" />
  
  <!-- Main vertical divider -->
  <line x1="800" y1="80" x2="800" y2="775" stroke="#58a6ff" stroke-width="1.5" />
  
  <!-- Centered Title inside header -->
  <text x="600" y="56" font-family="'Segoe UI', Roboto, sans-serif" font-weight="bold" font-size="20" fill="#58a6ff" text-anchor="middle" letter-spacing="1.5">CONCEPTUAL SURVEY PLAN — {parcel_name}</text>
  
  <!-- Column Headers -->
  <text x="45" y="115" font-family="'Segoe UI', Roboto, sans-serif" font-weight="bold" font-size="13" fill="#8b949e" letter-spacing="0.5">I. BOUNDARY TRAVERSE PLAN</text>
  <text x="820" y="115" font-family="'Segoe UI', Roboto, sans-serif" font-weight="bold" font-size="13" fill="#8b949e" letter-spacing="0.5">II. SURVEY DATA TABLES</text>
  
  <!-- Compass Rose -->
  <g transform="translate(130, 220)">
    <circle cx="0" cy="0" r="35" fill="none" stroke="#30363d" stroke-width="1.5" />
    <line x1="0" y1="-45" x2="0" y2="45" stroke="#ff4444" stroke-width="2" />
    <line x1="-45" y1="0" x2="45" y2="0" stroke="#30363d" stroke-width="1.5" />
    <polygon points="0,-45 -6,-12 0,-18 6,-12" fill="#ff4444" />
    <polygon points="0,45 -6,12 0,18 6,12" fill="#8b949e" />
    <polygon points="-45,0 -12,-6 -18,0 -12,6" fill="#8b949e" />
    <polygon points="45,0 12,-6 18,0 12,6" fill="#8b949e" />
    <text x="0" y="-52" font-family="'Segoe UI', Roboto, sans-serif" font-size="14" fill="#ff4444" text-anchor="middle" font-weight="bold">N</text>
    <text x="0" y="60" font-family="'Segoe UI', Roboto, sans-serif" font-size="11" fill="#8b949e" text-anchor="middle">S</text>
    <text x="58" y="4" font-family="'Segoe UI', Roboto, sans-serif" font-size="11" fill="#8b949e" text-anchor="middle">E</text>
    <text x="-58" y="4" font-family="'Segoe UI', Roboto, sans-serif" font-size="11" fill="#8b949e" text-anchor="middle">W</text>
  </g>
  
  <!-- Scale Bar -->
  <g transform="translate(650, 730)">
    <line x1="0" y1="0" x2="120" y2="0" stroke="#c9d1d9" stroke-width="2.5" />
    <line x1="0" y1="-6" x2="0" y2="6" stroke="#c9d1d9" stroke-width="2.5" />
    <line x1="60" y1="-6" x2="60" y2="6" stroke="#c9d1d9" stroke-width="1.5" />
    <line x1="120" y1="-6" x2="120" y2="6" stroke="#c9d1d9" stroke-width="2.5" />
    <text x="60" y="-12" font-family="'Courier New', monospace" font-size="11" fill="#c9d1d9" text-anchor="middle" font-weight="bold">SCALE: ~{(width/6):.1f} FT</text>
  </g>

  <!-- Boundary Path (Shadow + Glow + Main Stroke) -->
  <polygon points="{points_str}" fill="#58a6ff" fill-opacity="0.08" stroke="#58a6ff" stroke-width="3" stroke-linejoin="round" filter="url(#glow)" />
  <polygon points="{points_str}" fill="none" stroke="#58a6ff" stroke-width="1.5" stroke-linejoin="round" />
  
  <!-- Vertices and Labels -->
"""
    
    # Map from actual vertex index in vertices list to its conceptual label index
    conceptual_labels = {0: 0}
    current_label_idx = 1
    if course_metadata:
        for meta in course_metadata:
            end_idx = meta.get('end_vertex_idx')
            if end_idx is not None and end_idx < len(vertices):
                if end_idx == len(vertices) - 1:
                    conceptual_labels[end_idx] = 0
                else:
                    conceptual_labels[end_idx] = current_label_idx
                    current_label_idx += 1
    else:
        for idx in range(len(vertices)):
            conceptual_labels[idx] = idx

    # Draw points and vertex indices
    for idx, (x, y) in enumerate(vertices[:-1]): # Exclude redundant final closing point in drawing labels
        if idx not in conceptual_labels:
            continue
        label_idx = conceptual_labels[idx]
        tx, ty = transform(x, y)
        svg_content += f'  <circle cx="{tx}" cy="{ty}" r="4.5" fill="#ffffff" stroke="#ff7b72" stroke-width="2" />\n'
        svg_content += f'  <text x="{tx+8}" y="{ty-8}" font-family="monospace" font-size="10" fill="#8b949e" font-weight="bold">P{label_idx}</text>\n'

    # Assign line/curve tags matching the calls table
    course_tags = []
    line_counter = 0
    curve_counter = 0
    for c in courses:
        c_type = c.get('type', 'Line')
        if c_type.lower() == 'curve':
            curve_counter += 1
            course_tags.append(f"C{curve_counter}")
        else:
            line_counter += 1
            course_tags.append(f"L{line_counter}")

    # Draw segment labels on boundary path offset outward perpendicular to path
    svg_vertices = [transform(x, y) for x, y in vertices[:-1]]
    if svg_vertices:
        centroid_x = sum(tx for tx, ty in svg_vertices) / len(svg_vertices)
        centroid_y = sum(ty for tx, ty in svg_vertices) / len(svg_vertices)
    else:
        centroid_x, centroid_y = 400.0, 400.0

    if course_metadata:
        for meta in course_metadata:
            idx = meta.get('index')
            if idx is None or idx >= len(course_tags):
                continue
            tag = course_tags[idx]
            start_idx = meta.get('start_vertex_idx')
            end_idx = meta.get('end_vertex_idx')
            
            if start_idx is None or end_idx is None or start_idx >= len(vertices) or end_idx >= len(vertices):
                continue
                
            # SVG coordinates of start and end
            tx1, ty1 = transform(*vertices[start_idx])
            tx2, ty2 = transform(*vertices[end_idx])
            
            # Midpoint of segment/arc
            if meta.get('type', '').lower() == 'curve':
                mid_idx = (start_idx + end_idx) // 2
                mx, my = transform(*vertices[mid_idx])
            else:
                mx = (tx1 + tx2) / 2
                my = (ty1 + ty2) / 2
                
            # Vector along chord
            vx = tx2 - tx1
            vy = ty2 - ty1
            L = math.sqrt(vx**2 + vy**2)
            
            if L > 0:
                n1x, n1y = -vy / L, vx / L
                n2x, n2y = vy / L, -vx / L
                
                # Vector from midpoint to centroid (points inward)
                to_cent_x = centroid_x - mx
                to_cent_y = centroid_y - my
                
                # Choose normal pointing away from centroid
                dot1 = n1x * to_cent_x + n1y * to_cent_y
                if dot1 < 0:
                    nx, ny = n1x, n1y
                else:
                    nx, ny = n2x, n2y
            else:
                nx, ny = 0.0, -1.0
                
            # Offset outward
            offset_dist = 18.0
            lx = mx + offset_dist * nx
            ly = my + offset_dist * ny
            
            # Draw premium halo text
            svg_content += f'  <!-- Label {tag} -->\n'
            svg_content += f'  <text x="{lx}" y="{ly}" font-family="monospace" font-size="11" font-weight="bold" text-anchor="middle" dominant-baseline="middle" stroke="#0d1117" stroke-width="4" stroke-linejoin="round">{tag}</text>\n'
            svg_content += f'  <text x="{lx}" y="{ly}" font-family="monospace" font-size="11" font-weight="bold" text-anchor="middle" dominant-baseline="middle" fill="#ff7b72">{tag}</text>\n'

    # Legend Block
    svg_content += f"""
  <!-- Details Legend Panel -->
  <rect x="815" y="140" width="345" height="200" rx="8" fill="#161b22" fill-opacity="0.95" stroke="#30363d" stroke-width="1.5" />
  <text x="835" y="170" font-family="'Segoe UI', Roboto, sans-serif" font-weight="bold" font-size="14" fill="#58a6ff">CONCEPTUAL SURVEY MAP</text>
  <line x1="835" y1="180" x2="1140" y2="180" stroke="#30363d" stroke-width="1" />
  
  <text x="835" y="205" font-family="'Courier New', monospace" font-size="12" fill="#c9d1d9">ACREAGE:     {acreage:.4f} AC</text>
  <text x="835" y="230" font-family="'Courier New', monospace" font-size="12" fill="#c9d1d9">SQUARE FT:   {acreage*43560.0:,.2f} SQ FT</text>
  <text x="835" y="255" font-family="'Courier New', monospace" font-size="12" fill="#c9d1d9">CLOSURE ERR: {misclosure:.4f} FT</text>
  <text x="835" y="280" font-family="'Courier New', monospace" font-size="12" fill="#c9d1d9">TOTAL CALLS: {len(courses)}</text>
  <text x="835" y="305" font-family="'Courier New', monospace" font-size="10" fill="#8b949e">DATUM: local/project origin</text>
  
  <!-- Boundary Calls Table -->
  <g transform="translate(815, 360)">
    <rect x="0" y="0" width="345" height="400" rx="8" fill="#161b22" fill-opacity="0.9" stroke="#30363d" stroke-width="1.5" />
    <text x="20" y="28" font-family="'Segoe UI', Roboto, sans-serif" font-weight="bold" font-size="13" fill="#58a6ff">SURVEY COGO CALLS LIST</text>
    <line x1="20" y1="38" x2="325" y2="38" stroke="#30363d" stroke-width="1" />
"""

    y_offset = 60
    max_visible_calls = 15
    for idx, c in enumerate(courses):
        if idx >= max_visible_calls:
            break
        tag = course_tags[idx]
        c_type = c.get('type', 'Line')
        if c_type.lower() == 'line':
            dist = c.get('distance')
            dist_str = f"{dist:.2f}" if dist is not None else "N/A"
            text = f"{tag}: {c.get('bearing') or 'N/A'} - {dist_str}ft"
        else:
            r = c.get('radius')
            r_str = f"{r:.1f}" if r is not None else "N/A"
            l = c.get('arcLength') or c.get('distance')
            l_str = f"{l:.1f}" if l is not None else "N/A"
            
            # Find a 3rd piece of information to show (Chord Bearing, Chord Distance, Delta, or Direction)
            cb = c.get('chordBearing')
            cd = c.get('chordDistance')
            delta = c.get('delta')
            dir_val = c.get('curveDirection') or c.get('direction') or 'Right'
            
            if cb:
                third_str = f"CB={cb}"
            elif cd is not None and cd > 0:
                third_str = f"CD={cd:.1f}ft"
            elif delta is not None:
                third_str = f"Delta={delta:.1f}°"
            else:
                third_str = f"Dir={dir_val}"
                
            text = f"{tag}: Curve R={r_str} L={l_str} {third_str}"
        svg_content += f'    <text x="20" y="{y_offset}" font-family="monospace" font-size="11" fill="#c9d1d9">{text}</text>\n'
        y_offset += 20
        
    if len(courses) > max_visible_calls:
        svg_content += f'    <text x="20" y="{y_offset}" font-family="monospace" font-size="11" fill="#8b949e">... and {len(courses)-max_visible_calls} more calls</text>\n'

    svg_content += """  </g>
</svg>"""

    with open(output_path, 'w') as f:
        f.write(svg_content)
    print(f"[SVG Generator] Saved vector layout to {output_path}")

def format_comfyui_prompt(courses, traverse_res):
    """
    Creates a rich text prompt combining coordinates, acreage, boundary dimensions,
    and aesthetic instructions to pass to the ComfyUI CLIPTextEncode node.
    """
    courses_desc = []
    for idx, c in enumerate(courses):
        if c.get("type", "Line").lower() == "line":
            courses_desc.append(f"course {idx+1} is a line bearing {c.get('bearing')} extending {c.get('distance')} feet")
        else:
            courses_desc.append(f"course {idx+1} is a curve of radius {c.get('radius')} feet and length {c.get('arcLength')} feet deflecting to the {c.get('curveDirection', 'Right')}")
            
    desc_str = ", ".join(courses_desc)
    
    prompt = (
        f"A professional blueprint conceptual sketch of a land parcel boundaries. "
        f"The property outline is defined by {len(courses)} courses in sequence: {desc_str}. "
        f"The total calculated acreage of the property is {traverse_res['acreage']:.3f} acres. "
        f"Aesthetic: Survey layout plan, cartography map on vintage engineering blueprint paper, "
        f"technical details, CAD style, clean geometry, compass rose indicating North, scale bar, grid lines, "
        f"fine lines, high precision, architectural rendering, dark blueprint theme, labeled boundary lines, "
        f"legend table, highly detailed."
    )
    return prompt

def main():
    parser_args = argparse.ArgumentParser(description="COGO and ComfyUI Conceptual Map Generation Pipeline")
    parser_args.add_argument("--deed-file", type=str, help="Path to text file containing deed description")
    parser_args.add_argument("--courses-json", type=str, help="Path to JSON file containing courses array, or raw JSON string, to bypass Ollama parsing")
    parser_args.add_argument("--ollama-host", type=str, default="http://localhost:11434", help="Ollama API base URL")
    parser_args.add_argument("--comfy-host", type=str, default="http://localhost:8188", help="ComfyUI API base URL")
    parser_args.add_argument("--model", type=str, default="llama3.2:3b", help="Ollama LLM model name")
    parser_args.add_argument("--workflow", type=str, default="workflow_api.json", help="Path to ComfyUI workflow JSON")
    parser_args.add_argument("--output-img", type=str, default="conceptual_map.png", help="Path to output ComfyUI map PNG")
    parser_args.add_argument("--output-svg", type=str, default="conceptual_map.svg", help="Path to output vector map SVG")
    parser_args.add_argument("--output-report", type=str, default="traverse_report.json", help="Path to save COGO traverse calculation JSON")
    
    args = parser_args.parse_args()

    # Determine deed text source
    deed_text = ""
    if args.deed_file:
        try:
            with open(args.deed_file, 'r') as f:
                deed_text = f.read()
            print(f"[Pipeline] Loaded deed text from {args.deed_file}")
        except Exception as e:
            print(f"[Error] Failed to read deed file '{args.deed_file}': {e}", file=sys.stderr)
            sys.exit(1)
    elif not args.courses_json:
        print("[Pipeline] No deed file specified and no courses JSON provided. Using default sample deed.")
        deed_text = DEFAULT_DEED_TEXT

    # 1. Parse deed text to courses JSON
    print("\n=== Phase 1: Parsing/Loading courses JSON ===")
    courses = None
    if args.courses_json:
        try:
            # Try to parse as raw JSON string
            data = json.loads(args.courses_json)
            if isinstance(data, dict) and 'courses' in data:
                courses = data['courses']
            elif isinstance(data, list):
                courses = data
            print(f"[Pipeline] Successfully parsed {len(courses)} courses from JSON string argument.")
        except Exception:
            # Try to load as a file path
            try:
                with open(args.courses_json, 'r') as f:
                    data = json.load(f)
                    if isinstance(data, dict) and 'courses' in data:
                        courses = data['courses']
                    elif isinstance(data, list):
                        courses = data
                print(f"[Pipeline] Successfully loaded {len(courses)} courses from file: {args.courses_json}")
            except Exception as e:
                print(f"[Error] Failed to load or parse courses-json: {e}", file=sys.stderr)
                sys.exit(1)
    else:
        try:
            parsed_result = parser.parse_deed_to_json(deed_text, host=args.ollama_host, model=args.model)
            courses = parsed_result.get("courses", [])
            print(f"[Parser] Successfully parsed {len(courses)} courses from deed text.")
        except Exception as e:
            print(f"[Parser] Error parsing deed: {e}", file=sys.stderr)
            
            # Smart fallback: If it's our default sample deed, use pre-calculated courses
            if deed_text == DEFAULT_DEED_TEXT:
                print("[Parser] Falling back to pre-calculated course JSON for default sample.")
                courses = MOCK_DEED_COURSES
            else:
                print("[Error] Cannot proceed without a valid courses parse. Exiting.", file=sys.stderr)
                sys.exit(1)

    print(f"[Parser] Parsed course list:\n{json.dumps(courses, indent=2)}")

    # 2. Perform COGO Calculations
    print("\n=== Phase 2: Performing COGO calculations ===")
    try:
        traverse_res = cogo.calculate_traverse(courses)
        print(f"[COGO] Computed {len(traverse_res['vertices'])} vertices.")
        print(f"[COGO] Acreage: {traverse_res['acreage']:.4f} Acres ({traverse_res['acreage'] * 43560.0:.2f} sq ft)")
        print(f"[COGO] Closure Misclosure: {traverse_res['misclosure']:.4f} feet")
    except Exception as e:
        print(f"[COGO] Error in traverse calculations: {e}", file=sys.stderr)
        sys.exit(1)

    # Save traverse report JSON
    report_data = {
        "deedText": deed_text,
        "courses": courses,
        "traverse": {
            "vertices": traverse_res["vertices"],
            "misclosure": traverse_res["misclosure"],
            "acreage": traverse_res["acreage"]
        }
    }
    try:
        with open(args.output_report, 'w') as f:
            json.dump(report_data, f, indent=2)
        print(f"[Pipeline] Traverse calculations report saved to {args.output_report}")
    except Exception as e:
        print(f"[Warning] Failed to write report file: {e}", file=sys.stderr)

    # 3. Generate baseline vector SVG map
    print("\n=== Phase 3: Generating Vector Map (SVG) ===")
    try:
        generate_svg_map(
            traverse_res["vertices"], 
            courses, 
            traverse_res["acreage"], 
            traverse_res["misclosure"], 
            traverse_res.get("course_metadata", []),
            args.output_svg
        )
    except Exception as e:
        print(f"[SVG Generator] Error writing SVG: {e}", file=sys.stderr)

    # 4. Generate conceptual styled image with ComfyUI
    print("\n=== Phase 4: Triggering ComfyUI Image Generation ===")
    prompt_text = format_comfyui_prompt(courses, traverse_res)
    
    # Check if workflow file path is absolute, otherwise resolve relative to script
    workflow_path = args.workflow
    if not os.path.isabs(workflow_path):
        workflow_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), workflow_path)

    try:
        comfy_client.generate_map_with_comfy(
            workflow_path=workflow_path,
            prompt_text=prompt_text,
            output_image_path=args.output_img,
            host=args.comfy_host
        )
        print("[Pipeline] ComfyUI generation completed successfully!")
    except ConnectionError as e:
        print(f"\n[ComfyUI] Connection Error: {e}", file=sys.stderr)
        print("[ComfyUI] Skipping ComfyUI image generation since server is offline.", file=sys.stderr)
        print("[ComfyUI] NOTE: A mathematically correct vector map has been saved as conceptual_map.svg.", file=sys.stderr)
    except Exception as e:
        print(f"\n[ComfyUI] Error: {e}", file=sys.stderr)
        print("[ComfyUI] Generation failed. Vector map is still available as conceptual_map.svg.", file=sys.stderr)

    print("\n=== Pipeline Complete ===")

if __name__ == "__main__":
    main()
