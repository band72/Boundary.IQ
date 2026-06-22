import re
import math

# Regular expression to parse quadrant bearings: N/S degrees [minutes [seconds]] E/W
# e.g., N 13°29'15" W, S 89-05-20 W, N 45.5 E
BEARING_RE = re.compile(
    r'([NSns])\s*[\.\-]?\s*(\d+(?:\.\d+)?)\s*(?:[°d-]\s*(\d+(?:\.\d+)?)\s*(?:[\'′-]\s*(\d+(?:\.\d+)?)\s*["″]?)?)?\s*[\.\-]?\s*([EWew])'
)
def safe_float(val, default=0.0):
    if val is None:
        return default
    try:
        return float(val)
    except (ValueError, TypeError):
        return default

def normalize_bearing_syntax(text):
    if not text or not isinstance(text, str):
        return ""
    cleaned = text.strip()
    cleaned = cleaned.replace('º', '°').replace('o', '°').replace('O', '°')
    cleaned = cleaned.replace('’', "'").replace('‘', "'").replace('`', "'").replace('´', "'")
    cleaned = cleaned.replace('”', '"').replace('“', '"')
    return cleaned

def parse_bearing(bearing_str):
    """
    Parses a quadrant bearing string and returns its decimal degrees azimuth
    (clockwise from North, 0 to 360).
    """
    if not bearing_str or not isinstance(bearing_str, str):
        raise ValueError(f"Bearing is missing or not a valid string: '{bearing_str}'")
    cleaned = normalize_bearing_syntax(bearing_str)
    
    match = BEARING_RE.search(cleaned)
    if not match:
        raise ValueError(f"Could not parse quadrant bearing: '{bearing_str}' (normalized: '{cleaned}')")
    
    quad1 = match.group(1).upper()
    deg = float(match.group(2))
    minute = float(match.group(3)) if match.group(3) else 0.0
    second = float(match.group(4)) if match.group(4) else 0.0
    quad2 = match.group(5).upper()
    
    # Calculate decimal degrees
    decimal_degrees = deg + (minute / 60.0) + (second / 3600.0)
    
    # Map to azimuth (0 = North, 90 = East, 180 = South, 270 = West)
    if quad1 == 'N' and quad2 == 'E':
        azimuth = decimal_degrees
    elif quad1 == 'S' and quad2 == 'E':
        azimuth = 180.0 - decimal_degrees
    elif quad1 == 'S' and quad2 == 'W':
        azimuth = 180.0 + decimal_degrees
    elif quad1 == 'N' and quad2 == 'W':
        azimuth = 360.0 - decimal_degrees
    else:
        raise ValueError(f"Invalid quadrant combination: '{quad1}' and '{quad2}'")
        
    return azimuth % 360.0

def project_line(x, y, distance, azimuth_deg):
    """
    Projects a coordinate from (x, y) by a distance and azimuth (degrees).
    Northing is Y, Easting is X.
    """
    azimuth_rad = math.radians(azimuth_deg)
    x_next = x + distance * math.sin(azimuth_rad)
    y_next = y + distance * math.cos(azimuth_rad)
    return x_next, y_next

def generate_curve_points(x_start, y_start, radius, arc_length, curve_direction, azimuth_prev, steps_count=10):
    """
    Generates coordinate steps along a horizontal tangent curve.
    Returns: (list of (x, y) tuples, final_azimuth_deg)
    """
    if radius <= 0:
        raise ValueError("Radius must be greater than zero.")
    
    # Calculate delta angle (in radians)
    delta = arc_length / radius
    delta_deg = math.degrees(delta)
    
    # Determine starting radial azimuth pointing to the center of the circle
    # Curve to Right: center is rotated 90 degrees clockwise (+90)
    # Curve to Left: center is rotated 90 degrees counter-clockwise (-90)
    if curve_direction.lower() == 'right':
        azimuth_radial = (azimuth_prev + 90.0) % 360.0
        final_azimuth = (azimuth_prev + delta_deg) % 360.0
    else:
        azimuth_radial = (azimuth_prev - 90.0) % 360.0
        final_azimuth = (azimuth_prev - delta_deg) % 360.0
        
    # Calculate circle center (cx, cy)
    radial_rad = math.radians(azimuth_radial)
    cx = x_start + radius * math.sin(radial_rad)
    cy = y_start + radius * math.cos(radial_rad)
    
    # Start angle from center of the circle (Standard Cartesian atan2)
    angle_start = math.atan2(y_start - cy, x_start - cx)
    
    points = []
    # Interpolate along the arc
    for i in range(1, steps_count + 1):
        alpha = (i / steps_count) * delta
        if curve_direction.lower() == 'right':
            # Clockwise rotation: Cartesian angle decreases
            angle = angle_start - alpha
        else:
            # Counter-clockwise rotation: Cartesian angle increases
            angle = angle_start + alpha
            
        x_step = cx + radius * math.cos(angle)
        y_step = cy + radius * math.sin(angle)
        points.append((x_step, y_step))
        
    return points, final_azimuth

def generate_curve_points_from_chord(x_start, y_start, radius, chord_distance, chord_azimuth, curve_direction, steps_count=10):
    if radius <= 0:
        raise ValueError("Radius must be greater than zero.")
        
    chord_rad = math.radians(chord_azimuth)
    x_end = x_start + chord_distance * math.sin(chord_rad)
    y_end = y_start + chord_distance * math.cos(chord_rad)
    
    mx = (x_start + x_end) / 2
    my = (y_start + y_end) / 2
    
    c_half = chord_distance / 2
    h = math.sqrt(max(0.0, radius**2 - c_half**2))
    
    if curve_direction.lower() == 'right':
        center_az = (chord_azimuth + 90.0) % 360.0
    else:
        center_az = (chord_azimuth - 90.0) % 360.0
        
    center_rad = math.radians(center_az)
    cx = mx + h * math.sin(center_rad)
    cy = my + h * math.cos(center_rad)
    
    angle_start = math.atan2(y_start - cy, x_start - cx)
    angle_end = math.atan2(y_end - cy, x_end - cx)
    
    diff = angle_end - angle_start
    if curve_direction.lower() == 'right':
        if diff > 0:
            diff -= 2 * math.pi
    else:
        if diff < 0:
            diff += 2 * math.pi
            
    points = []
    for i in range(1, steps_count + 1):
        angle = angle_start + (i / steps_count) * diff
        x_step = cx + radius * math.cos(angle)
        y_step = cy + radius * math.sin(angle)
        points.append((x_step, y_step))
        
    radial_end_az = math.degrees(math.atan2(x_end - cx, y_end - cy))
    if radial_end_az < 0: radial_end_az += 360.0
    
    if curve_direction.lower() == 'right':
        final_az = (radial_end_az + 90.0) % 360.0
    else:
        final_az = (radial_end_az - 90.0) % 360.0
        
    return points, final_az

def compute_acreage(vertices):
    """
    Computes area in square feet using Shoelace formula and returns acreage.
    """
    if len(vertices) < 3:
        return 0.0
        
    n = len(vertices)
    area = 0.0
    for i in range(n):
        x1, y1 = vertices[i]
        x2, y2 = vertices[(i + 1) % n]
        area += x1 * y2 - x2 * y1
        
    sq_ft_area = 0.5 * abs(area)
    return sq_ft_area / 43560.0

def calculate_traverse(courses, start_x=5000.0, start_y=5000.0):
    """
    Orchestrates traverse computation from parsed courses.
    Each course should be a dict containing:
      - 'type': 'Line' or 'Curve'
      - For Line: 'bearing' (str), 'distance' (float)
      - For Curve: 'radius' (float), 'arcLength' (float), 'curveDirection' (str)
    """
    vertices = [(start_x, start_y)]
    current_x, current_y = start_x, start_y
    current_azimuth = 0.0 # Default starting azimuth
    
    first_course = True
    failed_courses = []
    course_metadata = []
    
    for idx, c in enumerate(courses):
        if not isinstance(c, dict):
            print(f"[COGO Warning] Course {idx+1} is not a dictionary. Skipping.")
            failed_courses.append({"index": idx+1, "course": c, "error": "Not a dictionary"})
            continue
            
        c_type = c.get('type', 'Line')
        if not c_type or not isinstance(c_type, str):
            c_type = 'Line'
            
        start_vertex_idx = len(vertices) - 1
        try:
            if c_type.lower() == 'line':
                bearing_str = c.get('bearing')
                
                # Recovery: look for bearing string in other fields
                if not bearing_str:
                    for k, v in c.items():
                        if isinstance(v, str):
                            norm_v = normalize_bearing_syntax(v)
                            m = BEARING_RE.search(norm_v)
                            if m:
                                bearing_str = m.group(0)
                                print(f"[COGO Recovery] Recovered bearing '{bearing_str}' from field '{k}' on course {idx+1}")
                                break
                
                distance = safe_float(c.get('distance', 0.0))
                # Recovery: look for distance number or text in other fields
                if distance == 0.0:
                    for k, v in c.items():
                        if k != 'type' and isinstance(v, (int, float)):
                            distance = float(v)
                            print(f"[COGO Recovery] Recovered distance {distance} from field '{k}' on course {idx+1}")
                            break
                        elif isinstance(v, str):
                            dist_match = re.search(r'(\d+(?:\.\d+)?)\s*(?:feet|ft|FEET|FT|meters|m|chains|ch)\b', v)
                            if dist_match:
                                distance = float(dist_match.group(1))
                                print(f"[COGO Recovery] Recovered distance {distance} with unit from text '{v}' on course {idx+1}")
                                break
                            all_nums = re.findall(r'\d+(?:\.\d+)?', v)
                            if all_nums:
                                distance = float(all_nums[-1])
                                print(f"[COGO Recovery] Recovered last number {distance} as distance from text '{v}' on course {idx+1}")
                                break
                                
                if not bearing_str:
                    raise ValueError("Bearing is missing or invalid.")
                    
                azimuth = parse_bearing(bearing_str)
                current_azimuth = azimuth
                current_x, current_y = project_line(current_x, current_y, distance, azimuth)
                vertices.append((current_x, current_y))
                
            elif c_type.lower() == 'curve':
                radius = safe_float(c.get('radius', 0.0))
                arc_length = safe_float(c.get('arcLength', c.get('distance', 0.0)))
                direction = c.get('curveDirection', 'Right')
                
                # Recovery for curves
                if radius == 0.0:
                    for k, v in c.items():
                        if 'radius' in k.lower() and isinstance(v, (int, float)):
                            radius = float(v)
                            break
                            
                if radius <= 0 or arc_length <= 0:
                    # Handle curve with invalid/zero radius or length: treat as straight line if bearing is present, or print warning
                    bearing_str = c.get('bearing')
                    # Recovery: look for bearing string in other fields
                    if not bearing_str:
                        for k, v in c.items():
                            if isinstance(v, str):
                                norm_v = normalize_bearing_syntax(v)
                                m = BEARING_RE.search(norm_v)
                                if m:
                                    bearing_str = m.group(0)
                                    break
                    
                    if bearing_str:
                        print(f"[COGO Warning] Curve on course {idx+1} has invalid radius/length (R={radius}, L={arc_length}). Treating as straight line with bearing {bearing_str}.")
                        azimuth = parse_bearing(bearing_str)
                        current_azimuth = azimuth
                        current_x, current_y = project_line(current_x, current_y, arc_length, azimuth)
                        vertices.append((current_x, current_y))
                    else:
                        print(f"[COGO Warning] Skipping invalid curve on course {idx+1} (R={radius}, L={arc_length}) due to no valid bearing fallback.")
                        raise ValueError(f"Curve has invalid radius/length (R={radius}, L={arc_length}) and no bearing fallback.")
                    
                    end_vertex_idx = len(vertices) - 1
                    course_metadata.append({
                        'index': idx,
                        'type': c_type,
                        'start_vertex_idx': start_vertex_idx,
                        'end_vertex_idx': end_vertex_idx
                    })
                    first_course = False
                    continue
    
                chord_bearing = c.get('chordBearing')
                chord_distance = safe_float(c.get('chordDistance', 0.0))

                if chord_bearing and chord_distance > 0:
                    try:
                        chord_az = parse_bearing(chord_bearing)
                        steps, final_az = generate_curve_points_from_chord(
                            current_x, current_y, radius, chord_distance, chord_az, direction
                        )
                        vertices.extend(steps)
                        current_x, current_y = steps[-1]
                        current_azimuth = final_az
                    except Exception as chord_err:
                        print(f"[COGO Warning] Curve on course {idx+1} chord projection failed: {chord_err}. Falling back to tangent.")
                        steps, final_az = generate_curve_points(
                            current_x, current_y, radius, arc_length, direction, current_azimuth
                        )
                        vertices.extend(steps)
                        current_x, current_y = steps[-1]
                        current_azimuth = final_az
                else:
                    if first_course:
                        # If first course is a curve, assume it starts tangent to North/East or needs reference
                        # Usually tangent to North (azimuth=0)
                        pass
                        
                    steps, final_az = generate_curve_points(
                        current_x, current_y, radius, arc_length, direction, current_azimuth
                    )
                    vertices.extend(steps)
                    current_x, current_y = steps[-1]
                    current_azimuth = final_az
                
            end_vertex_idx = len(vertices) - 1
            course_metadata.append({
                'index': idx,
                'type': c_type,
                'start_vertex_idx': start_vertex_idx,
                'end_vertex_idx': end_vertex_idx
            })
            first_course = False
            
        except Exception as err:
            print(f"[COGO Warning] Course {idx+1} calculation failed: {err}")
            failed_courses.append({
                "index": idx + 1,
                "course": c,
                "error": str(err)
            })
            
    # Calculate closing error
    closing_err_x = current_x - start_x
    closing_err_y = current_y - start_y
    misclosure = math.sqrt(closing_err_x**2 + closing_err_y**2)
    
    acreage = compute_acreage(vertices)
    
    return {
        'vertices': vertices,
        'misclosure': misclosure,
        'acreage': acreage,
        'failed_courses': failed_courses,
        'course_metadata': course_metadata
    }
