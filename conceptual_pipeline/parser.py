import json
import urllib.request
import urllib.error
import sys

def get_available_models(host="http://localhost:11434"):
    """
    Queries the Ollama tags endpoint to list installed models.
    """
    url = f"{host}/api/tags"
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=5) as response:
            data = json.loads(response.read().decode('utf-8'))
            return [model['name'] for model in data.get('models', [])]
    except urllib.error.URLError as e:
        print(f"[Warning] Failed to connect to Ollama at {url}: {e}", file=sys.stderr)
        return []
    except Exception as e:
        print(f"[Warning] Unexpected error checking Ollama models: {e}", file=sys.stderr)
        return []

def select_model(available_models, preferred_model="llama3.2:3b"):
    """
    Selects a model from available models, falling back gracefully.
    """
    if not available_models:
        return None
    
    # Clean up names for comparison (e.g. "llama3.2:latest" or "llama3.2:3b")
    # Try exact match first
    if preferred_model in available_models:
        return preferred_model
    
    # Try prefix match or similar popular models
    for model in available_models:
        if preferred_model.split(':')[0] in model:
            return model
            
    # Preferred order of fallback models that are typically available in this env
    fallbacks = ["gemma3:4b", "deepseek-r1:8b", "llama3.2:3b", "deepseek-r1:14b", "gemma4:26b"]
    for fb in fallbacks:
        if fb in available_models:
            return fb
        for model in available_models:
            if fb.split(':')[0] in model:
                return model
                
    # Return the first available model as last resort
    return available_models[0]

def parse_deed_to_json(deed_text, host="http://localhost:11434", model=None):
    """
    Sends the metes and bounds deed description to a local Ollama instance
    to extract courses in structured JSON format.
    """
    available = get_available_models(host)
    if not available:
        raise ConnectionError(
            f"Ollama is not running or not accessible at {host}.\n"
            "Please ensure Ollama is running (`ollama serve`) and accessible."
        )
        
    selected = select_model(available, model or "llama3.2:3b")
    if not selected:
        raise ValueError("No Ollama models available to perform parsing.")
        
    print(f"[Parser] Using Ollama model: '{selected}'")

    system_prompt = (
        "You are an expert land surveyor assistant. Parse the following metes and bounds legal description "
        "into a structured JSON array of courses in sequence. Each course must represent a single boundary call.\n\n"
        "IMPORTANT: Distinguish between tie-in/commencing calls (which lead from a starting monument or section corner "
        "to the Point of Beginning) and the actual boundary calls of the parcel. Do NOT include these tie-in/commencing "
        "calls in the 'courses' list. The first course in the 'courses' list MUST be the first call starting from "
        "the Point of Beginning. Ignore all calls before the Point of Beginning.\n\n"
        "Return ONLY a JSON object with a single root key 'courses' containing a list of objects.\n"
        "Each course object must have the following fields:\n"
        "1. 'type': Either 'Line' or 'Curve' (string).\n"
        "2. For a 'Line' course, include:\n"
        "   - 'bearing': The quadrant bearing string exactly as written (e.g. 'N 13°29\'15\" W' or 'S 89-05-20 W' or 'N 45.5 E')\n"
        "   - 'distance': The distance of the line in feet as a float (e.g., 124.5)\n"
        "3. For a 'Curve' course, include:\n"
        "   - 'radius': The radius of the curve in feet as a float (e.g., 500.0)\n"
        "   - 'arcLength': The length of the arc in feet as a float (e.g., 120.0)\n"
        "   - 'curveDirection': The direction of curve deflection, either 'Right' or 'Left' (string).\n"
        "   - 'distance': The distance/arcLength value as a float (as a fallback)\n\n"
        "Ensure the output conforms exactly to this JSON schema without extra text or explanation. Example:\n"
        "{\n"
        "  \"courses\": [\n"
        "    {\"type\": \"Line\", \"bearing\": \"N 13°29'15\\\" W\", \"distance\": 124.5},\n"
        "    {\"type\": \"Curve\", \"radius\": 500.0, \"arcLength\": 120.0, \"curveDirection\": \"Right\", \"distance\": 120.0},\n"
        "    {\"type\": \"Line\", \"bearing\": \"S 45°00'00\\\" E\", \"distance\": 250.0}\n"
        "  ]\n"
        "}"
    )

    url = f"{host}/api/generate"
    payload = {
        "model": selected,
        "prompt": f"{system_prompt}\n\nDeed Text:\n\"\"\"\n{deed_text}\n\"\"\"",
        "format": "json",
        "stream": False,
        "options": {
            "temperature": 0.0  # Zero temperature for deterministic parsing
        }
    }
    
    headers = {'Content-Type': 'application/json'}
    req_data = json.dumps(payload).encode('utf-8')
    
    try:
        req = urllib.request.Request(url, data=req_data, headers=headers, method='POST')
        # Allow 30 seconds for the model to think/respond
        with urllib.request.urlopen(req, timeout=60) as response:
            resp_body = response.read().decode('utf-8')
            resp_json = json.loads(resp_body)
            
            raw_response = resp_json.get('response', '')
            if not raw_response:
                raise ValueError("Ollama returned an empty response.")
                
            parsed_data = json.loads(raw_response)
            if 'courses' not in parsed_data:
                raise ValueError("JSON response from model is missing 'courses' list.")
                
            return parsed_data
            
    except urllib.error.URLError as e:
        raise ConnectionError(f"Failed to communicate with Ollama at {url}: {e}")
    except json.JSONDecodeError as e:
        raise ValueError(f"Failed to decode JSON from Ollama response: {e}\nRaw output was: {raw_response}")
