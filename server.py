"""
Backend Flask API server for the Interactive History Platform.
Handles text retrieval from Wikipedia/Wikidata and answer generation using a local LLM.
"""

# Import Flask for building the web API
from flask import Flask, request, jsonify

# Import CORS middleware to allow requests from the frontend
from flask_cors import CORS

# Import requests library for making HTTP calls to external APIs
import requests

# Import json for working with JSON data
import json

# Import regex for text processing
import re

# Import the database module for storing and retrieving data
from db import Database

# Create a Flask application instance
app = Flask(__name__)

# Enable CORS to allow frontend to communicate with backend
CORS(app)

# Create a database connection instance for data operations
db = Database()

# Configuration for the Ollama API (local LLM service)
OLLAMA_API = 'http://localhost:11434/api/generate'  # Ollama API endpoint
OLLAMA_MODEL = 'llama2'                              # Model to use for generation

# Configuration for Wikipedia API
WIKI_API = 'https://en.wikipedia.org/w/api.php'

# Configuration for Wikidata API
WIKIDATA_API = 'https://www.wikidata.org/w/api.php'


def get_wiki_text(title, max_len=2000):
    """Fetch historical text from Wikipedia for a given article title."""
    try:
        # Build the parameters for the Wikipedia API query
        params = {
            'action': 'query',         # We want to query articles
            'format': 'json',          # Return results as JSON
            'titles': title,           # The article title to search for
            'prop': 'extracts|pageimages',  # Get text extract and images
            'exintro': 1,              # Get intro section only (shorter)
            'redirects': 1,            # Follow redirects
        }
        
        # Make the HTTP request to Wikipedia
        res = requests.get(WIKI_API, params=params, timeout=10)
        res.raise_for_status()
        
        # Parse the response as JSON
        data = res.json()

        # Extract the pages from the response
        pages = data.get('query', {}).get('pages', {})
        if not pages:
            return None

        # Get the first (and usually only) page result
        page = list(pages.values())[0]
        
        # Extract the article text
        extract = page.get('extract', '')
        
        # If no text was found, return None
        if not extract:
            return None

        # Remove HTML tags from the extract
        extract = re.sub(r'<[^>]+>', '', extract)
        
        # Limit the text length to avoid token limits
        extract = extract[:max_len]
        
        # Get the Wikipedia page ID to build a direct URL
        page_id = page.get('pageid')
        url = f'https://en.wikipedia.org/?curid={page_id}' if page_id else None

        # Return the text and metadata
        return {
            'text': extract,
            'source': 'Wikipedia',
            'url': url,
            'status': 'success',
        }
    except Exception as e:
        # Log and return error
        print(f"wiki error: {e}")
        return {'status': 'error', 'error': str(e)}


def get_wikidata_text(wikidata_id, max_len=2000):
    """Fetch description and information from Wikidata for a given entity."""
    try:
        # Build parameters for the Wikidata API query
        params = {
            'action': 'wbgetentities',  # Get entity information
            'ids': wikidata_id,         # The Wikidata ID to fetch
            'format': 'json',           # Return as JSON
            'languages': 'en',          # English language preferred
        }
        
        # Make the HTTP request to Wikidata
        res = requests.get(WIKIDATA_API, params=params, timeout=10)
        res.raise_for_status()
        
        # Parse the response as JSON
        data = res.json()

        # Extract the entities from the response
        entities = data.get('entities', {})
        if not entities:
            return None

        # Get the first entity
        entity = list(entities.values())[0]
        
        # Extract the English description
        desc = entity.get('descriptions', {}).get('en', {}).get('value', '')
        
        # If no description found, return None
        if not desc:
            return None

        # Get the English label (name)
        label = entity.get('labels', {}).get('en', {}).get('value', 'Unknown')
        
        # Build the Wikidata URL
        url = f'https://www.wikidata.org/wiki/{wikidata_id}'
        
        # Combine label and description, limit by max length
        full = f"{label}: {desc}"[:max_len]

        # Return the text and metadata
        return {
            'text': full,
            'source': 'Wikidata',
            'url': url,
            'status': 'success',
        }
    except Exception as e:
        # Log and return error
        print(f"wikidata error: {e}")
        return {'status': 'error', 'error': str(e)}


def fetch_historical_text(name, wikidata_id=None, wiki_url=None):
    """Fetch historical text from multiple sources in order of preference."""
    # Try the Wikipedia URL first if provided
    if wiki_url:
        try:
            # Extract the article title from the URL format
            if ':' in wiki_url:
                title = wiki_url.split(':')[-1].replace('_', ' ')
            else:
                title = wiki_url.replace('_', ' ')
            
            # Attempt to get text from Wikipedia using the URL
            res = get_wiki_text(title)
            if res and res.get('status') == 'success':
                return res
        except Exception as e:
            print(f"wiki url parse error: {e}")

    # Try Wikidata if available
    if wikidata_id:
        res = get_wikidata_text(wikidata_id)
        if res and res.get('status') == 'success':
            return res

    # Try searching Wikipedia by landmark name as last resort
    try:
        res = get_wiki_text(name)
        if res and res.get('status') == 'success':
            return res
    except Exception as e:
        print(f"wiki name search error: {e}")

    # If all methods failed, return error status
    return {'status': 'no_data', 'text': None, 'error': 'No text found'}


def call_ollama(prompt, temp=0.3):
    """Call the local Ollama LLM service to generate a response."""
    try:
        # Build the payload for the Ollama API
        payload = {
            'model': OLLAMA_MODEL,      # Use llama2 model
            'prompt': prompt,            # The prompt/question
            'temperature': temp,         # Temperature for randomness (0.3 = deterministic)
            'stream': False,             # Don't stream output, get full response at once
        }
        
        # Make the request to Ollama
        res = requests.post(OLLAMA_API, json=payload, timeout=60)
        res.raise_for_status()
        
        # Parse the response
        data = res.json()
        
        # Return the generated response
        return {'answer': data.get('response', '').strip(), 'status': 'success'}
    except requests.exceptions.ConnectionError:
        # Ollama service is not running
        return {'status': 'error', 'error': 'Ollama not running. Try: ollama serve'}
    except Exception as e:
        # Other errors
        print(f"ollama error: {e}")
        return {'status': 'error', 'error': str(e)}


def make_prompt(name, metadata, text, question, year=None):
    """Build the RAG prompt for the LLM with system instructions, context, and question."""
    # System instructions for the AI model
    sys = "You are a historical expert. Answer ONLY from the provided context. Don't make stuff up. Keep it brief."
    
    # Convert metadata dictionary into readable key-value pairs
    meta_str_parts = []
    for k, v in metadata.items():
        meta_str_parts.append(f"  {k}: {v}")
    meta_str = '\n'.join(meta_str_parts)
    
    # Use the provided text or a placeholder if empty
    ctx = text if text else "[No context available]"
    
    # Add year hint if provided
    time_hint = f"\nFocus on the year {year}." if year else ""
    
    # Build and return the complete prompt
    return f"""{sys}

LANDMARK: {name}
METADATA:
{meta_str}

CONTEXT:
{ctx}

QUESTION: {question}{time_hint}

ANSWER:"""

# API endpoint for health check - confirms the server is running
@app.route('/api/health', methods=['GET'])
def health():
    """Simple health check endpoint to verify the server is running."""
    return jsonify({
        'status': 'ok',
        'service': 'History Platform API',
        'version': '1.0'
    })


# API endpoint for retrieving historical text about a landmark
@app.route('/api/retrieve-text', methods=['POST'])
def get_text():
    """Retrieve historical text for a landmark from various sources."""
    try:
        # Get the JSON data from the request
        data = request.get_json()
        
        # Extract the landmark information from the request
        name = data.get('landmark_name', '')
        wikidata_id = data.get('wikidata_id')
        wiki_url = data.get('wikipedia_url')

        # Validate that we have at least the landmark name
        if not name:
            return jsonify({'status': 'error', 'error': 'Missing landmark_name'}), 400

        # Fetch historical text using multiple sources
        res = fetch_historical_text(name, wikidata_id, wiki_url)
        
        # Generate a unique landmark ID for database storage
        lm_id = f"lm-{name.lower().replace(' ', '-')}"
        
        # Save the result to the database
        if res.get('status') == 'success':
            db.save_historical_text(lm_id, res.get('text'), res.get('source'), res.get('url'), 'success')
        else:
            db.save_historical_text(lm_id, status='error', error=res.get('error'))

        # Return the result to the frontend
        return jsonify(res)
    except Exception as e:
        print(f"error in get_text: {e}")
        return jsonify({'status': 'error', 'error': str(e)}), 500


# API endpoint for generating answers to questions about landmarks
@app.route('/api/generate-answer', methods=['POST'])
def gen_answer():
    """Generate an AI answer to a question about a landmark."""
    try:
        # Get the JSON data from the request
        data = request.get_json()
        
        # Extract the information needed for answer generation
        name = data.get('landmark_name', '')
        metadata = data.get('landmark_metadata', {})
        text = data.get('historical_text')
        question = data.get('question', '')
        year = data.get('year')

        # Validate required fields
        if not name or not question:
            return jsonify({'status': 'error', 'error': 'Missing landmark_name or question'}), 400

        # Build the prompt for the LLM
        prompt = make_prompt(name, metadata, text, question, year)
        
        # Call the Ollama service to generate an answer
        res = call_ollama(prompt, temp=0.3)

        # Generate a unique landmark ID for database storage
        lm_id = f"lm-{name.lower().replace(' ', '-')}"
        
        # Save the result to the database
        if res.get('status') == 'success':
            db.save_answer(lm_id, question, res.get('answer'), year, 'success')
        else:
            db.save_answer(lm_id, question, year=year, status='error', error=res.get('error'))

        # Return the result with source information
        return jsonify({
            'status': res.get('status'),
            'answer': res.get('answer'),
            'error': res.get('error'),
            'source': 'Ollama LLM',
        })
    except Exception as e:
        print(f"error in gen_answer: {e}")
        return jsonify({'status': 'error', 'error': str(e)}), 500


# API endpoint for retrieving usage statistics
@app.route('/api/statistics', methods=['GET'])
def get_stats():
    """Retrieve aggregate statistics about platform usage."""
    try:
        conn = db.get_conn()
        c = conn.cursor()
        c.execute('SELECT COUNT(*) FROM landmarks')
        total_landmarks = c.fetchone()[0]
        c.execute('SELECT COUNT(*) FROM historical_texts')
        total_texts = c.fetchone()[0]
        c.execute('SELECT COUNT(*) FROM generated_answers')
        total_answers = c.fetchone()[0]
        conn.close()
        return jsonify({
            'status': 'success',
            'total_landmarks': total_landmarks,
            'total_texts': total_texts,
            'total_answers': total_answers,
        })
    except Exception as e:
        print(f"stats error: {e}")
        return jsonify({'status': 'error', 'error': str(e)}), 500


# API endpoint for retrieving evaluation test results
@app.route('/api/evaluation', methods=['GET'])
def get_eval():
    """Retrieve evaluation test results from the database."""
    try:
        test_name = request.args.get('test_name')
        results = db.get_eval_results(test_name)
        return jsonify({
            'status': 'success',
            'results': results,
            'count': len(results),
        })
    except Exception as e:
        print(f"eval error: {e}")
        return jsonify({'status': 'error', 'error': str(e)}), 500


# Error handler 
@app.errorhandler(404)
def not_found(err):
    """Handle requests to non-existent endpoints."""
    return jsonify({'status': 'error', 'error': 'Not found'}), 404
@app.errorhandler(500)
def server_err(err):
    """Handle internal server errors."""
    return jsonify({'status': 'error', 'error': 'Server error'}), 500


# Main execution block - runs when server is started
if __name__ == '__main__':
    # Log startup information
    print("Starting backend...")
    print(f"Ollama API: {OLLAMA_API}")
    print(f"Model: {OLLAMA_MODEL}")
    print("Make sure Ollama is running (ollama serve)")
    
    # Start the Flask development server
    app.run(debug=True, host='0.0.0.0', port=5000)
