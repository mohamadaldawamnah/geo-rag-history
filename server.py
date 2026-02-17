"""
Backend Flask API server for the Interactive History Platform.
Handles text retrieval from Wikipedia/Wikidata and answer generation using a local LLM.
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import requests
import json
import re
from db import Database

app = Flask(__name__)
CORS(app)
db = Database()

OLLAMA_API = 'http://localhost:11434/api/generate'
OLLAMA_MODEL = 'llama2'
WIKI_API = 'https://en.wikipedia.org/w/api.php'
WIKIDATA_API = 'https://www.wikidata.org/w/api.php'


def fetch_wikipedia_text(article_title, max_text_length=2000):
    """Fetch historical text from Wikipedia for a given article title."""
    try:
        query_parameters = {
            'action': 'query',
            'format': 'json',
            'titles': article_title,
            'prop': 'extracts|pageimages',
            'exintro': 1,
            'redirects': 1,
        }
        
        response = requests.get(WIKI_API, params=query_parameters, timeout=10)
        response.raise_for_status()
        
        response_data = response.json()
        pages = response_data.get('query', {}).get('pages', {})
        if not pages:
            return None

        page = list(pages.values())[0]
        article_extract = page.get('extract', '')
        
        if not article_extract:
            return None

        article_extract = re.sub(r'<[^>]+>', '', article_extract)
        article_extract = article_extract[:max_text_length]
        page_id = page.get('pageid')
        wikipedia_url = f'https://en.wikipedia.org/?curid={page_id}' if page_id else None

        return {
            'text': article_extract,
            'source': 'Wikipedia',
            'url': wikipedia_url,
            'status': 'success',
        }
    except Exception as error:
        print(f"Wikipedia API error: {error}")
        return {'status': 'error', 'error': str(error)}


def fetch_wikidata_text(wikidata_entity_id, max_text_length=2000):
    """Fetch description and information from Wikidata for a given entity."""
    try:
        query_parameters = {
            'action': 'wbgetentities',
            'ids': wikidata_entity_id,
            'format': 'json',
            'languages': 'en',
        }
        
        response = requests.get(WIKIDATA_API, params=query_parameters, timeout=10)
        response.raise_for_status()
        
        response_data = response.json()
        entities = response_data.get('entities', {})
        if not entities:
            return None

        entity = list(entities.values())[0]
        entity_description = entity.get('descriptions', {}).get('en', {}).get('value', '')
        
        if not entity_description:
            return None

        entity_label = entity.get('labels', {}).get('en', {}).get('value', 'Unknown')
        wikidata_url = f'https://www.wikidata.org/wiki/{wikidata_entity_id}'
        combined_text = f"{entity_label}: {entity_description}"[:max_text_length]

        return {
            'text': combined_text,
            'source': 'Wikidata',
            'url': wikidata_url,
            'status': 'success',
        }
    except Exception as error:
        print(f"Wikidata API error: {error}")
        return {'status': 'error', 'error': str(error)}


def retrieve_historical_text_from_multiple_sources(landmark_name, wikidata_entity_id=None, wikipedia_url=None):
    """Fetch historical text from multiple sources in order of preference."""
    if wikipedia_url:
        try:
            if ':' in wikipedia_url:
                article_title = wikipedia_url.split(':')[-1].replace('_', ' ')
            else:
                article_title = wikipedia_url.replace('_', ' ')
            
            result = fetch_wikipedia_text(article_title)
            if result and result.get('status') == 'success':
                return result
        except Exception as error:
            print(f"Error parsing Wikipedia URL: {error}")

    if wikidata_entity_id:
        result = fetch_wikidata_text(wikidata_entity_id)
        if result and result.get('status') == 'success':
            return result

    try:
        result = fetch_wikipedia_text(landmark_name)
        if result and result.get('status') == 'success':
            return result
    except Exception as error:
        print(f"Error searching Wikipedia by name: {error}")

    return {'status': 'no_data', 'text': None, 'error': 'No text found'}


def call_ollama_language_model(user_prompt, temperature=0.3):
    """Call the local Ollama LLM service to generate a response."""
    try:
        request_payload = {
            'model': OLLAMA_MODEL,
            'prompt': user_prompt,
            'temperature': temperature,
            'stream': False,
        }
        
        response = requests.post(OLLAMA_API, json=request_payload, timeout=60)
        response.raise_for_status()
        response_data = response.json()
        
        return {'answer': response_data.get('response', '').strip(), 'status': 'success'}
    except requests.exceptions.ConnectionError:
        return {'status': 'error', 'error': 'Ollama not running. Try: ollama serve'}
    except Exception as error:
        print(f"Ollama LLM error: {error}")
        return {'status': 'error', 'error': str(error)}


def build_rag_system_prompt(landmark_name, landmark_metadata, historical_context, user_question, year_filter=None):
    """Build the RAG prompt for the LLM with system instructions, context, and question."""
    system_instructions = "You are a historical expert. Answer ONLY from the provided context. Don't make stuff up. Keep it brief."
    
    metadata_lines = []
    for metadata_key, metadata_value in landmark_metadata.items():
        metadata_lines.append(f"  {metadata_key}: {metadata_value}")
    metadata_string = '\n'.join(metadata_lines)
    
    context_text = historical_context if historical_context else "[No context available]"
    year_hint = f"\nFocus on the year {year_filter}." if year_filter else ""
    
    complete_prompt = f"""System Instructions:
{system_instructions}

LANDMARK: {landmark_name}
METADATA:
{metadata_string}

HISTORICAL CONTEXT:
{context_text}

QUESTION: {user_question}{year_hint}

ANSWER:"""
    
    return complete_prompt

@app.route('/api/health', methods=['GET'])
def health():
    """Simple health check endpoint to verify the server is running."""
    return jsonify({
        'status': 'ok',
        'service': 'History Platform API',
        'version': '1.0'
    })


@app.route('/api/retrieve-text', methods=['POST'])
def get_text():
    """Retrieve historical text for a landmark from various sources."""
    try:
        data = request.get_json()
        landmark_name = request_data.get('landmark_name', '')
        wikidata_entity_id = request_data.get('wikidata_id')
        wikipedia_url = request_data.get('wikipedia_url')

        if not landmark_name:
            return jsonify({'status': 'error', 'error': 'Missing landmark_name'}), 400

        retrieval_result = retrieve_historical_text_from_multiple_sources(
            landmark_name, 
            wikidata_entity_id, 
            wikipedia_url
        )
        
        landmark_database_id = f"lm-{landmark_name.lower().replace(' ', '-')}"
        
        if retrieval_result.get('status') == 'success':
            db.save_historical_text_for_landmark(
                landmark_database_id, 
                retrieval_result.get('text'), 
                retrieval_result.get('source'), 
                retrieval_result.get('url'), 
                'success'
            )
        else:
            db.save_historical_text_for_landmark(
                landmark_database_id, 
                status='error', 
                error_message=retrieval_result.get('error')
            )

        return jsonify(res)
    except Exception as e:
        print(f"error in get_text: {e}")
        return jsonify({'status': 'error', 'error': str(e)}), 500


@app.route('/api/generate-answer', methods=['POST'])
def handle_answer_generation_request():
    """Generate an AI answer to a question about a landmark."""
    try:
        request_data = request.get_json()
        landmark_name = request_data.get('landmark_name', '')
        landmark_metadata = request_data.get('landmark_metadata', {})
        historical_text = request_data.get('historical_text')
        user_question = request_data.get('question', '')
        year_filter = request_data.get('year')

        if not landmark_name or not user_question:
            return jsonify({'status': 'error', 'error': 'Missing landmark_name or question'}), 400

        system_prompt = build_rag_system_prompt(
            landmark_name, 
            landmark_metadata, 
            historical_text, 
            user_question, 
            year_filter
        )
        
        generation_result = call_ollama_language_model(system_prompt, temperature=0.3)
        landmark_database_id = f"lm-{landmark_name.lower().replace(' ', '-')}"
        
        if generation_result.get('status') == 'success':
            db.save_generated_answer_for_landmark(
                landmark_database_id, 
                user_question, 
                generation_result.get('answer'), 
                year_filter, 
                'success'
            )
        else:
            db.save_generated_answer_for_landmark(
                landmark_database_id, 
                user_question, 
                year_filter=year_filter, 
                generation_status='error', 
                error_message=generation_result.get('error')
            )

        return jsonify({
            'status': generation_result.get('status'),
            'answer': generation_result.get('answer'),
            'error': generation_result.get('error'),
            'source': 'Ollama LLM',
        })
    except Exception as error:
        print(f"Error in handle_answer_generation_request: {error}")
        return jsonify({'status': 'error', 'error': str(error)}), 500


@app.route('/api/statistics', methods=['GET'])
def retrieve_platform_statistics():
    """Retrieve aggregate statistics about platform usage."""
    try:
        database_connection = db.get_database_connection()
        database_cursor = database_connection.cursor()
        
        database_cursor.execute('SELECT COUNT(*) FROM landmarks')
        total_landmarks_count = database_cursor.fetchone()[0]
        
        database_cursor.execute('SELECT COUNT(*) FROM historical_texts')
        total_texts_count = database_cursor.fetchone()[0]
        
        database_cursor.execute('SELECT COUNT(*) FROM generated_answers')
        total_answers_count = database_cursor.fetchone()[0]
        
        database_connection.close()
        
        return jsonify({
            'status': 'success',
            'total_landmarks': total_landmarks_count,
            'total_texts': total_texts_count,
            'total_answers': total_answers_count,
        })
    except Exception as error:
        print(f"Error retrieving statistics: {error}")
        return jsonify({'status': 'error', 'error': str(error)}), 500


@app.route('/api/evaluation', methods=['GET'])
def retrieve_evaluation_results():
    """Retrieve evaluation test results from the database."""
    try:
        test_name = request.args.get('test_name')
        evaluation_results = db.retrieve_evaluation_results(test_name)
        return jsonify({
            'status': 'success',
            'results': evaluation_results,
            'count': len(evaluation_results),
        })
    except Exception as error:
        print(f"Error retrieving evaluation results: {error}")
        return jsonify({'status': 'error', 'error': str(error)}), 500


@app.errorhandler(404)
def handle_not_found_error(error):
    """Handle requests to non-existent endpoints."""
    return jsonify({'status': 'error', 'error': 'Not found'}), 404


@app.errorhandler(500)
def handle_internal_server_error(error):
    """Handle internal server errors."""
    return jsonify({'status': 'error', 'error': 'Server error'}), 500


if __name__ == '__main__':
    print("Starting backend...")
    print(f"Ollama API: {OLLAMA_API}")
    print(f"Model: {OLLAMA_MODEL}")
    print("Make sure Ollama is running (ollama serve)")
    app.run(debug=True, host='0.0.0.0', port=5000)
