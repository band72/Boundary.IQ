import json
import time
import urllib.request
import urllib.parse
import urllib.error
import sys

def find_positive_clip_node(workflow):
    """
    Finds the node ID of the positive CLIPTextEncode node in a ComfyUI workflow.
    Tries to distinguish it from the negative prompt node by checking keys/titles.
    """
    for node_id, node in workflow.items():
        if node.get("class_type") == "CLIPTextEncode":
            text = node.get("inputs", {}).get("text", "")
            meta = node.get("_meta", {})
            title = meta.get("title", "").lower() if isinstance(meta, dict) else ""
            
            # Identify typical negative indicators
            negative_indicators = ["ugly", "bad", "deformed", "lowres", "watermark", "signature", "negative"]
            is_negative = any(ind in text.lower() for ind in negative_indicators) or "negative" in title
            
            if not is_negative:
                return node_id
                
    # Fallback to the first CLIPTextEncode found
    for node_id, node in workflow.items():
        if node.get("class_type") == "CLIPTextEncode":
            return node_id
            
    return None

def download_image(host, filename, subfolder, img_type, output_image_path):
    """
    Downloads a rendered image from the ComfyUI /view endpoint.
    """
    params = {
        "filename": filename,
        "subfolder": subfolder,
        "type": img_type
    }
    query = urllib.parse.urlencode(params)
    url = f"{host}/view?{query}"
    
    print(f"[ComfyUI] Downloading image from {url} to {output_image_path}...")
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=15) as response:
            with open(output_image_path, 'wb') as f:
                f.write(response.read())
        print(f"[ComfyUI] Image successfully saved to {output_image_path}")
    except Exception as e:
        raise IOError(f"Failed to download image from ComfyUI: {e}")

def create_dummy_workflow():
    """
    Generates a default SD 1.5 API format workflow for generating boundary map sketches.
    """
    return {
        "3": {
            "inputs": {
                "seed": 42,
                "steps": 25,
                "cfg": 7.5,
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": 1.0,
                "model": ["4", 0],
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["5", 0]
            },
            "class_type": "KSampler",
            "_meta": {"title": "KSampler"}
        },
        "4": {
            "inputs": {
                "ckpt_name": "v1-5-pruned-emaonly.safetensors"
            },
            "class_type": "CheckpointLoaderSimple",
            "_meta": {"title": "Load Checkpoint"}
        },
        "5": {
            "inputs": {
                "width": 768,
                "height": 768,
                "batch_size": 1
            },
            "class_type": "EmptyLatentImage",
            "_meta": {"title": "Empty Latent Image"}
        },
        "6": {
            "inputs": {
                "text": "A conceptual cartography sketch map, blueprint of a land parcel layout with boundaries",
                "clip": ["4", 1]
            },
            "class_type": "CLIPTextEncode",
            "_meta": {"title": "CLIPTextEncode (Positive)"}
        },
        "7": {
            "inputs": {
                "text": "ugly, blurry, low quality, photorealistic, noise, 3d, realistic photo, watermark, signature",
                "clip": ["4", 1]
            },
            "class_type": "CLIPTextEncode",
            "_meta": {"title": "CLIPTextEncode (Negative)"}
        },
        "8": {
            "inputs": {
                "samples": ["3", 0],
                "vae": ["4", 2]
            },
            "class_type": "VAEDecode",
            "_meta": {"title": "VAE Decode"}
        },
        "9": {
            "inputs": {
                "filename_prefix": "BoundaryIQ_ConceptualMap",
                "images": ["8", 0]
            },
            "class_type": "SaveImage",
            "_meta": {"title": "Save Image"}
        }
    }

def generate_map_with_comfy(workflow_path, prompt_text, output_image_path, host="http://localhost:8188"):
    """
    Orchestrates the ComfyUI API workflow update, prompt queuing, execution polling, and image download.
    """
    # Load or generate workflow_api.json
    try:
        with open(workflow_path, 'r') as f:
            workflow = json.load(f)
        print(f"[ComfyUI] Loaded existing workflow template from {workflow_path}")
    except FileNotFoundError:
        print(f"[ComfyUI] {workflow_path} not found. Generating default workflow template...")
        workflow = create_dummy_workflow()
        try:
            with open(workflow_path, 'w') as f:
                json.dump(workflow, f, indent=2)
            print(f"[ComfyUI] Saved default workflow template to {workflow_path}")
        except Exception as e:
            print(f"[Warning] Could not save workflow template file: {e}", file=sys.stderr)

    # Find and update CLIPTextEncode positive node
    clip_node_id = find_positive_clip_node(workflow)
    if not clip_node_id:
        raise ValueError("Could not locate CLIPTextEncode node in the workflow.")
        
    workflow[clip_node_id]["inputs"]["text"] = prompt_text
    print(f"[ComfyUI] Set CLIP positive prompt to: \"{prompt_text[:100]}...\"")

    url = f"{host}/prompt"
    payload = {"prompt": workflow}
    headers = {'Content-Type': 'application/json'}
    req_data = json.dumps(payload).encode('utf-8')
    
    print(f"[ComfyUI] Sending execution request to ComfyUI at {url}...")
    try:
        req = urllib.request.Request(url, data=req_data, headers=headers, method='POST')
        with urllib.request.urlopen(req, timeout=10) as response:
            resp_body = response.read().decode('utf-8')
            resp_json = json.loads(resp_body)
            prompt_id = resp_json.get("prompt_id")
            if not prompt_id:
                raise ValueError(f"ComfyUI response did not return a prompt_id. Response: {resp_json}")
            print(f"[ComfyUI] Successfully queued prompt. ID: {prompt_id}")
    except urllib.error.URLError as e:
        raise ConnectionError(
            f"Failed to connect to ComfyUI at {host}.\n"
            "Please verify that ComfyUI is running on that port."
        )

    # Poll history endpoint
    history_url = f"{host}/history/{prompt_id}"
    print(f"[ComfyUI] Polling history endpoint for completion...")
    
    # 300 seconds (5 minutes) timeout to support slow/complex generations
    max_seconds = 300
    for second in range(max_seconds):
        try:
            req = urllib.request.Request(history_url)
            with urllib.request.urlopen(req, timeout=5) as response:
                history_data = json.loads(response.read().decode('utf-8'))
                
                # Check if our prompt_id execution is present and complete
                if prompt_id in history_data:
                    print(f"[ComfyUI] Execution completed in {second}s!")
                    history = history_data[prompt_id]
                    outputs = history.get("outputs", {})
                    
                    # Find output image filename
                    image_info = None
                    for node_id, node_output in outputs.items():
                        if "images" in node_output:
                            image_info = node_output["images"][0]
                            break
                            
                    if not image_info:
                        raise ValueError("No images found in ComfyUI history output.")
                        
                    filename = image_info.get("filename")
                    subfolder = image_info.get("subfolder", "")
                    img_type = image_info.get("type", "output")
                    
                    # Download the image
                    download_image(host, filename, subfolder, img_type, output_image_path)
                    return True
                    
        except Exception as e:
            # Silence minor polling connection slips but log if it's a critical error
            if "No images found" in str(e) or "history output" in str(e):
                raise e
            pass
            
        time.sleep(1.0)
        
    raise TimeoutError(f"ComfyUI prompt execution {prompt_id} timed out after {max_seconds} seconds.")
