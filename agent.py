#!/usr/bin/env python3
"""
Boundary.IQ — Antigravity Agent
────────────────────────────────
Uses the Google Antigravity (AGY) SDK to orchestrate deed processing through
local LLMs via the Boundary.IQ Node.js server API.

The Antigravity agent handles the high-level reasoning loop; its *tools*
call your local models (Ollama / LM Studio / llama.cpp) and the Boundary.IQ
REST endpoints for traverse computation.

Usage:
    python agent.py                          # interactive loop
    python agent.py --prompt "Process deed at ~/Downloads/sample.pdf"
    python agent.py --file ~/Downloads/sample.pdf
    python agent.py --list-models            # list available local models
"""

import asyncio
import argparse
import os
import sys
import json
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv(dotenv_path=Path(__file__).parent / '.env')

# ── Config ────────────────────────────────────────────────────────────────────
API_BASE        = os.getenv('BOUNDARYIQ_API',  'http://localhost:5050/api')
OLLAMA_BASE     = os.getenv('OLLAMA_URL',      'http://127.0.0.1:11434')
OPENAI_BASE_URL = os.getenv('OPENAI_BASE_URL', 'http://127.0.0.1:11434/v1')
GEMINI_API_KEY  = os.getenv('GEMINI_API_KEY') or os.getenv('Gemini__ApiKey')

# ── Custom Tools ──────────────────────────────────────────────────────────────

async def call_local_llm(prompt: str, model: str = 'gemma4:e2b', base_url: str = None) -> str:
    """
    Call a local LLM via the OpenAI-compatible /v1/chat/completions endpoint.
    Works with Ollama, LM Studio, llama.cpp, vLLM, etc.

    Args:
        prompt:   The user prompt to send.
        model:    Model identifier (e.g. 'gemma4:e2b', 'llama3.1:8b').
        base_url: OpenAI-compat base URL. Defaults to OPENAI_BASE_URL env var.

    Returns:
        The model's text response.
    """
    url = f"{(base_url or OPENAI_BASE_URL).rstrip('/')}/chat/completions"
    payload = {
        'model': model,
        'messages': [{'role': 'user', 'content': prompt}],
        'temperature': 0.2,
    }
    async with httpx.AsyncClient(timeout=300) as client:
        resp = await client.post(url, json=payload)
        resp.raise_for_status()
        data = resp.json()
        return data['choices'][0]['message']['content']


async def list_local_models(base_url: str = None) -> list[str]:
    """
    Return available local model names from Ollama or any OpenAI-compatible server.

    Args:
        base_url: OpenAI-compat base URL.

    Returns:
        List of model ID strings.
    """
    url = f"{(base_url or OPENAI_BASE_URL).rstrip('/')}/models"
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            resp = await client.get(url)
            resp.raise_for_status()
            data = resp.json()
            return [m['id'] for m in data.get('data', [])]
        except Exception as e:
            # Fall back to Ollama native API
            try:
                resp = await client.get(f"{OLLAMA_BASE}/api/tags")
                resp.raise_for_status()
                data = resp.json()
                return [m['name'] for m in data.get('models', [])]
            except Exception:
                return []


async def process_deed_file(file_path: str, pob_n: float = 5000.0, pob_e: float = 5000.0) -> dict:
    """
    Submit a deed PDF/image to the Boundary.IQ server for AI extraction + traverse.

    Args:
        file_path: Absolute or relative path to a PDF or image file.
        pob_n:     Point of Beginning Northing coordinate.
        pob_e:     Point of Beginning Easting coordinate.

    Returns:
        Dict with keys: status, extraction, traverse, legalDescription, error.
    """
    path = Path(file_path).expanduser().resolve()
    if not path.exists():
        return {'status': 'error', 'error': f'File not found: {path}'}

    params = {'pobN': pob_n, 'pobE': pob_e, 'units': 'Feet'}
    async with httpx.AsyncClient(timeout=600) as client:
        with open(path, 'rb') as f:
            files = {'images': (path.name, f, 'application/pdf' if path.suffix.lower() == '.pdf' else 'image/png')}
            resp = await client.post(
                f'{API_BASE}/batchdeed/process',
                params=params,
                files=files,
            )
        if resp.status_code != 200:
            return {'status': 'error', 'error': f'Server error {resp.status_code}: {resp.text[:300]}'}
        data = resp.json()
        results = data.get('results', [])
        return results[0] if results else {'status': 'error', 'error': 'No results returned.'}


async def get_active_model() -> dict:
    """Query the Boundary.IQ server for the currently active AI provider and model."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f'{API_BASE}/settings/model')
        resp.raise_for_status()
        return resp.json()


async def switch_model(provider: str, model: str, openai_base_url: str = None) -> dict:
    """
    Switch the Boundary.IQ server to use a different AI provider/model.

    Args:
        provider:         'gemini', 'ollama', or 'openai'
        model:            Model ID string.
        openai_base_url:  Only required when provider='openai'.

    Returns:
        Server response dict.
    """
    body = {'provider': provider, 'model': model}
    if openai_base_url:
        body['openaiBaseUrl'] = openai_base_url
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            f'{API_BASE}/settings/model',
            json=body,
            headers={'Content-Type': 'application/json'},
        )
        resp.raise_for_status()
        return resp.json()


# ── Agent Entry Point ─────────────────────────────────────────────────────────

async def run_agent(initial_prompt: str = None, file_path: str = None):
    """Start an Antigravity agent with Boundary.IQ tools wired in."""
    try:
        from google.antigravity import Agent, LocalAgentConfig
    except ImportError:
        print('❌  google-antigravity is not installed.')
        print('    Run: pip install google-antigravity')
        sys.exit(1)

    if not GEMINI_API_KEY:
        print('⚠  GEMINI_API_KEY not set — Antigravity agent orchestration requires a Gemini key.')
        print('   Get one at: https://aistudio.google.com/app/api-keys')
        print('   Set it in your .env file as: GEMINI_API_KEY=your_key_here')
        print()
        print('   Note: the *tools* still call your LOCAL LLMs — only the orchestration layer uses Gemini.')
        sys.exit(1)

    system_instructions = """\
You are the Boundary.IQ Deed Processing Agent — an expert Professional Land Surveyor
and Computational Geometer with full access to both cloud and local AI models.

Your toolkit includes:
  • call_local_llm       — run prompts against a local Ollama/LM Studio model
  • list_local_models    — enumerate available local model names
  • process_deed_file    — extract boundary traverse data from a deed PDF via the server
  • get_active_model     — check which AI provider/model is currently active
  • switch_model         — change the active AI provider at runtime

When asked to process a deed, first check which model is active, then use process_deed_file.
If the result fails to close, use call_local_llm to reason about the misclosure error.
Always report: classification, course count, area (acres), precision ratio, and closure status.
"""

    config = LocalAgentConfig(
        api_key=GEMINI_API_KEY,
        system_instructions=system_instructions,
        tools=[
            call_local_llm,
            list_local_models,
            process_deed_file,
            get_active_model,
            switch_model,
        ],
    )

    print('🌐 Boundary.IQ Antigravity Agent')
    print(f'   API: {API_BASE}')
    print(f'   Local LLM: {OPENAI_BASE_URL}')
    print()

    async with Agent(config=config) as agent:
        if file_path:
            prompt = f'Process the deed file at: {file_path}'
            print(f'📄 Processing: {file_path}\n')
            response = await agent.chat(prompt)
            print('Agent:', await response.text())
        elif initial_prompt:
            response = await agent.chat(initial_prompt)
            print('Agent:', await response.text())
        else:
            await agent.run_interactive_loop()


async def cmd_list_models():
    models = await list_local_models()
    if models:
        print(f'✓ {len(models)} local model(s) available:')
        for m in models:
            print(f'  • {m}')
    else:
        print('✗ No local models found. Is Ollama running? Try: ollama serve')


def main():
    parser = argparse.ArgumentParser(description='Boundary.IQ Antigravity Agent')
    parser.add_argument('--prompt', '-p', help='Single prompt to send to the agent')
    parser.add_argument('--file',   '-f', help='Deed PDF/image file to process')
    parser.add_argument('--list-models', action='store_true', help='List available local LLM models and exit')
    args = parser.parse_args()

    if args.list_models:
        asyncio.run(cmd_list_models())
        return

    asyncio.run(run_agent(
        initial_prompt=args.prompt,
        file_path=args.file,
    ))


if __name__ == '__main__':
    main()
