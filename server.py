from flask import Flask, request, jsonify
from flask_cors import CORS
import requests
import json
import re
from urllib.parse import unquote, urlparse
from db import Database

app = Flask(__name__)
CORS(app)
db = Database()

OLLAMA_API = 'http://localhost:11434/api/generate'
OLLAMA_MODEL = 'mistral'
WIKI_API = 'https://en.wikipedia.org/w/api.php'
WIKIDATA_API = 'https://www.wikidata.org/w/api.php'
GITHUB_TOKEN = os.environ.get('GITHUB_TOKEN')

HEADERS = {
    'User-Agent': 'HistoryPlatform/1.0 (Educational Research) +https://github.com'
}


def fetch_wikipedia_text(article_title):
    try:
        query_parameters = {
            'action': 'query',
            'format': 'json',
            'titles': article_title,
            'prop': 'extracts|pageimages',
            'explaintext': 1,
            'redirects': 1,
        }
        
        response = requests.get(WIKI_API, params=query_parameters, headers=HEADERS, timeout=10)
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
        page_id = page.get('pageid')
        wikipedia_url = f'https://en.wikipedia.org/?curid={page_id}' if page_id else None

        return {
            'text': article_extract,
            'source': 'Wikipedia',
            'url': wikipedia_url,
            'status': 'success',
        }
    except Exception as error:
        return {'status': 'error', 'error': str(error)}


def fetch_wikidata_text(wikidata_entity_id):
    try:
        query_parameters = {
            'action': 'wbgetentities',
            'ids': wikidata_entity_id,
            'format': 'json',
            'languages': 'en',
        }
        
        response = requests.get(WIKIDATA_API, params=query_parameters, headers=HEADERS, timeout=10)
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
        combined_text = f"{entity_label}: {entity_description}"

        return {
            'text': combined_text,
            'source': 'Wikidata',
            'url': wikidata_url,
            'status': 'success',
        }
    except Exception as error:
        return {'status': 'error', 'error': str(error)}


def retrieve_historical_text_from_multiple_sources(landmark_name, wikidata_entity_id=None, wikipedia_url=None):
    def extract_wikipedia_title(raw_value):
        value = (raw_value or '').strip()
        if not value:
            return None

        if value.startswith('http://') or value.startswith('https://'):
            parsed = urlparse(value)
            if parsed.path.startswith('/wiki/'):
                return unquote(parsed.path.replace('/wiki/', '', 1)).replace('_', ' ')
            return None

        if ':' in value:
            value = value.split(':', 1)[1]

        return unquote(value).replace('_', ' ')

    if wikipedia_url:
        try:
            article_title = extract_wikipedia_title(wikipedia_url)
            if article_title:
                result = fetch_wikipedia_text(article_title)
                if result and result.get('status') == 'success':
                    return result
        except Exception as error:
            pass

    try:
        result = fetch_wikipedia_text(landmark_name)
        if result and result.get('status') == 'success':
            return result
    except Exception as error:
        pass

    if wikidata_entity_id:
        result = fetch_wikidata_text(wikidata_entity_id)
        if result and result.get('status') == 'success':
            return result

    return {'status': 'no_data', 'text': None, 'error': 'No text found'}


def call_ollama_language_model(user_prompt, temperature=0.3):
    try:
        request_payload = {
            'model': OLLAMA_MODEL,
            'prompt': user_prompt,
            'temperature': temperature,
            'stream': False,
        }
        
        response = requests.post(OLLAMA_API, json=request_payload, timeout=360)
        response.raise_for_status()
        response_data = response.json()
        
        return {'answer': response_data.get('response', '').strip(), 'status': 'success'}
    except requests.exceptions.ConnectionError:
        return {'status': 'error', 'error': 'Ollama not running. Try: ollama serve'}
    except Exception as error:
        return {'status': 'error', 'error': str(error)}


def call_github_ai_unconstrained(user_prompt, temperature=0.7):
    try:
        github_api_endpoint = 'https://models.inference.ai.azure.com/chat/completions'
        
        request_payload = {
            'model': 'gpt-4o',
            'messages': [
                {
                    'role': 'system',
                    'content': 'You are a knowledgeable historian assistant. You can provide information based on your training, even if sources are not explicitly cited. Your responses are not fact-checked against Wikipedia.'
                },
                {
                    'role': 'user',
                    'content': user_prompt
                }
            ],
            'temperature': temperature,
            'max_tokens': 1000,
        }
        
        headers = {
            'Authorization': f'Bearer {GITHUB_TOKEN}',
            'Content-Type': 'application/json',
        }
        
        response = requests.post(github_api_endpoint, json=request_payload, headers=headers, timeout=30)
        
        response.raise_for_status()
        response_data = response.json()
        
        answer_text = response_data.get('choices', [{}])[0].get('message', {}).get('content', '').strip()
        
        if answer_text:
            return {'answer': answer_text, 'status': 'success'}
        else:
            return {'status': 'error', 'error': 'No response from GitHub AI'}
            
    except requests.exceptions.ConnectionError:
        return {'status': 'error', 'error': 'Cannot reach GitHub API. Check internet connection.'}
    except requests.exceptions.HTTPError as http_error:
        error_msg = str(http_error)
        if '401' in error_msg or '403' in error_msg:
            return {'status': 'error', 'error': 'GitHub token invalid or expired. Check GITHUB_TOKEN.'}
        return {'status': 'error', 'error': f'GitHub API error: {error_msg}'}
    except Exception as error:
        return {'status': 'error', 'error': str(error)}


def build_rag_system_prompt(landmark_name, landmark_metadata, historical_context, user_question, year_filter=None):
    system_instructions = """You are a historical fact extractor. CRITICAL RULES:
1. Extract ONLY sentences and facts that exist in the provided context
2. Do NOT invent, infer, or generate plausible-sounding but false information
3. If the requested year is NOT mentioned in the context, respond: "No information for that time period in the source material"
4. If the question cannot be answered from the context, explicitly say so
5. Your answer must be grounded in the provided text - never speculate
6. Provide all relevant details found in the context. Do not shorten for brevity."""
    
    metadata_lines = []
    for metadata_key, metadata_value in landmark_metadata.items():
        metadata_lines.append(f"  {metadata_key}: {metadata_value}")
    metadata_string = '\n'.join(metadata_lines)
    
    context_text = historical_context if historical_context else "[No context available]"
    
    year_requirement = ""
    if year_filter:
        year_requirement = f"\n[CRITICAL] Only answer if the year {year_filter} is explicitly mentioned in the context. If not found, respond: 'No information for the year {year_filter} in the source material.'"
    
    complete_prompt = f"""System Instructions:
{system_instructions}

LANDMARK: {landmark_name}
METADATA:
{metadata_string}

HISTORICAL CONTEXT:
{context_text}

QUESTION: {user_question}{year_requirement}

REQUIREMENT: Extract your answer directly from the provided context. Do not invent or infer facts.

ANSWER:"""
    
    return complete_prompt


def normalize_optional_year(year_value):
    if year_value is None:
        return None

    if isinstance(year_value, int):
        return year_value if 1000 <= year_value <= 2100 else None

    text_value = str(year_value).strip()
    if not text_value:
        return None

    try:
        parsed = int(text_value)
    except (TypeError, ValueError):
        return None

    return parsed if 1000 <= parsed <= 2100 else None


def normalize_landmark_for_frontend(landmark_row, ref_lat=None, ref_lon=None):
    tags_value = landmark_row.get('tags')
    if isinstance(tags_value, str):
        try:
            tags_value = json.loads(tags_value)
        except json.JSONDecodeError:
            tags_value = {}
    if not isinstance(tags_value, dict):
        tags_value = {}

    lat = float(landmark_row.get('lat'))
    lon = float(landmark_row.get('lon'))

    distance_km = 0.0
    if ref_lat is not None and ref_lon is not None:
        distance_km = (((lat - ref_lat) ** 2 + (lon - ref_lon) ** 2) ** 0.5) * 111.0

    return {
        'id': landmark_row.get('id'),
        'name': landmark_row.get('name') or '(Unnamed)',
        'lat': lat,
        'lon': lon,
        'distance': distance_km,
        'osmType': landmark_row.get('osm_type') or 'node',
        'osmId': landmark_row.get('osm_id'),
        'tags': tags_value,
        'wikidata': landmark_row.get('wikidata_id'),
        'wikipedia': landmark_row.get('wikipedia_url'),
    }

@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok',
        'service': 'History Platform API',
        'version': '1.0'
    })


@app.route('/api/retrieve-text', methods=['POST'])
def get_text():
    try:
        request_data = request.get_json() or {}
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
                retrieval_status='error', 
                error_message=retrieval_result.get('error')
            )

        return jsonify(retrieval_result)
    except Exception as e:
        return jsonify({'status': 'error', 'error': str(e)}), 500


@app.route('/api/generate-answer', methods=['POST'])
def handle_answer_generation_request():
    try:
        request_data = request.get_json()
        landmark_name = request_data.get('landmark_name', '')
        landmark_metadata = request_data.get('landmark_metadata', {})
        historical_text = request_data.get('historical_text')
        user_question = request_data.get('question', '')
        year_filter = normalize_optional_year(request_data.get('year'))

        if not landmark_name or not user_question:
            return jsonify({'status': 'error', 'error': 'Missing landmark_name or question'}), 400

        context_length = len(historical_text or '') if historical_text else 0
        is_limited = context_length < 150
        
        if is_limited:
            landmark_type = landmark_metadata.get('type', 'place')
            location_hint = landmark_metadata.get('address', landmark_metadata.get('name', 'this location'))
            
            fallback_prompt = f"""About: {landmark_name}
Type: {landmark_type}
Location: {location_hint}

User's question: {user_question}

I don't have detailed historical records for this specific {landmark_type}, but based on what I know about such places, here's what I can tell you:

Provide a helpful 2-3 sentence response based on your knowledge of {landmark_type}s like this one. Be informative and practical."""
            
            generation_result = call_ollama_language_model(fallback_prompt, temperature=0.5)
            landmark_database_id = f"lm-{landmark_name.lower().replace(' ', '-')}"
            
            if generation_result.get('status') == 'success':
                db.save_generated_answer_for_landmark(
                    landmark_database_id, 
                    user_question, 
                    generation_result.get('answer'), 
                    year_filter, 
                    'success'
                )
            
            return jsonify({
                'status': generation_result.get('status'),
                'answer': generation_result.get('answer'),
                'error': generation_result.get('error'),
                'source': 'Ollama LLM (general knowledge)',
                'note': 'Limited specific information available; providing general knowledge about this type of location'
            })

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
            'source': 'Ollama LLM (fact-based)',
        })
    except Exception as error:
        return jsonify({'status': 'error', 'error': str(error)}), 500


@app.route('/api/statistics', methods=['GET'])
def retrieve_platform_statistics():
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
        return jsonify({'status': 'error', 'error': str(error)}), 500


@app.route('/api/evaluation', methods=['GET'])
def retrieve_evaluation_results():
    try:
        test_name = request.args.get('test_name')
        evaluation_results = db.retrieve_evaluation_results(test_name)
        return jsonify({
            'status': 'success',
            'results': evaluation_results,
            'count': len(evaluation_results),
        })
    except Exception as error:
        return jsonify({'status': 'error', 'error': str(error)}), 500


@app.route('/api/cache-landmarks', methods=['POST'])
def cache_landmarks_for_region():
    try:
        request_data = request.get_json() or {}
        landmarks = request_data.get('landmarks', [])
        region_name = (request_data.get('region_name') or '').strip() or 'Cached Area'
        center_lat = request_data.get('center_lat')
        center_lon = request_data.get('center_lon')
        radius_m = request_data.get('radius_m')

        if not isinstance(landmarks, list) or not landmarks:
            return jsonify({'status': 'error', 'error': 'Missing landmarks list'}), 400

        saved_count = 0
        for landmark in landmarks:
            if not isinstance(landmark, dict):
                continue

            landmark_id = landmark.get('id')
            landmark_name = landmark.get('name')
            landmark_lat = landmark.get('lat')
            landmark_lon = landmark.get('lon')
            if not landmark_id or not landmark_name or landmark_lat is None or landmark_lon is None:
                continue

            save_ok = db.save_landmark_to_database({
                'id': landmark_id,
                'name': landmark_name,
                'lat': float(landmark_lat),
                'lon': float(landmark_lon),
                'osmType': landmark.get('osmType'),
                'osmId': landmark.get('osmId'),
                'tags': landmark.get('tags', {}),
                'wikidata': landmark.get('wikidata'),
                'wikipedia': landmark.get('wikipedia'),
            })
            if save_ok:
                saved_count += 1

        if center_lat is not None and center_lon is not None and radius_m is not None and saved_count > 0:
            db.save_cached_region(
                name=region_name,
                center_lat=center_lat,
                center_lon=center_lon,
                radius_m=radius_m,
                landmark_count=saved_count,
            )

        return jsonify({
            'status': 'success',
            'saved_count': saved_count,
            'requested_count': len(landmarks),
        })
    except Exception as error:
        return jsonify({'status': 'error', 'error': str(error)}), 500


@app.route('/api/cached-landmarks', methods=['GET'])
def get_cached_landmarks_for_region():
    try:
        lat = request.args.get('lat', type=float)
        lon = request.args.get('lon', type=float)
        radius_km = request.args.get('radius_km', default=1.0, type=float)

        if lat is None or lon is None:
            return jsonify({'status': 'error', 'error': 'Missing lat/lon'}), 400

        if radius_km <= 0:
            radius_km = 1.0

        cached_rows = db.retrieve_landmarks_by_geographic_area(lat, lon, radius_km)
        landmarks = [normalize_landmark_for_frontend(row, lat, lon) for row in cached_rows]
        landmarks.sort(key=lambda item: item.get('distance', 0))

        return jsonify({
            'status': 'success',
            'landmarks': landmarks,
            'count': len(landmarks),
        })
    except Exception as error:
        return jsonify({'status': 'error', 'error': str(error)}), 500


@app.route('/api/cached-regions', methods=['GET'])
def get_cached_regions():
    try:
        limit = request.args.get('limit', default=100, type=int)
        if limit <= 0:
            limit = 100

        regions = db.retrieve_cached_regions(limit=limit)
        return jsonify({
            'status': 'success',
            'regions': regions,
            'count': len(regions),
        })
    except Exception as error:
        return jsonify({'status': 'error', 'error': str(error)}), 500


@app.route('/api/fetch-wikipedia', methods=['POST'])
def fetch_wiki_by_wikidata():
    try:
        request_data = request.get_json() or {}
        wikidata_id = request_data.get('wikidata_id')
        
        if not wikidata_id:
            return jsonify({'status': 'error', 'error': 'Missing wikidata_id'}), 400
        
        wikidata_params = {
            'action': 'wbgetentities',
            'ids': wikidata_id,
            'format': 'json',
            'languages': 'en',
            'props': 'labels|descriptions|sitelinks',
        }
        
        wikidata_response = requests.get(WIKIDATA_API, params=wikidata_params, headers=HEADERS, timeout=10)
        wikidata_response.raise_for_status()
        
        wikidata_data = wikidata_response.json()
        entities = wikidata_data.get('entities', {})
        
        if not entities:
            return jsonify({'status': 'no_data', 'error': 'No data found for Wikidata ID'}), 200
        
        entity = list(entities.values())[0]
        
        sitelinks = entity.get('sitelinks', {})
        wikipedia_site = sitelinks.get('enwiki', {})
        wikipedia_title = wikipedia_site.get('title')
        
        if not wikipedia_title:
            return jsonify({'status': 'no_data', 'error': 'No Wikipedia article found'}), 200
        
        wiki_result = fetch_wikipedia_text(wikipedia_title)
        
        if wiki_result and wiki_result.get('status') == 'success':
            return jsonify({
                'status': 'success',
                'text': wiki_result.get('text'),
                'source': wiki_result.get('source'),
                'url': wiki_result.get('url')
            })
        else:
            return jsonify({'status': 'no_data', 'error': 'Failed to fetch Wikipedia'}), 200
            
    except Exception as error:
        return jsonify({'status': 'error', 'error': str(error)}), 500


@app.route('/api/summarize-wiki', methods=['POST'])
def summarize_wikipedia_text():
    try:
        request_data = request.get_json() or {}
        wikipedia_text = request_data.get('wikipedia_text', '')
        landmark_name = request_data.get('landmark_name', 'this place')
        max_words = request_data.get('max_words', 40)
        
        if not wikipedia_text:
            return jsonify({'status': 'error', 'error': 'Missing wikipedia_text'}), 400
        
        summary_prompt = f"""Summarize the following text about {landmark_name} in exactly 2 sentences, keeping it under {max_words} words. Focus on historical significance and key facts. No introductions or explanations, just the summary:

TEXT:
{wikipedia_text[:1500]}

SUMMARY:"""
        mistral_payload = {
            'model': 'qwen3:4b',  # default (llama 2) or 'mistral:7b' depending on your Ollama setup
            'prompt': summary_prompt,
            'stream': False,
            'temperature': 0.3,
            'top_p': 0.9,
        }
        
        llm_response = requests.post(OLLAMA_API, json=mistral_payload, timeout=360)
        llm_response.raise_for_status()
        
        llm_data = llm_response.json()
        summary_text = llm_data.get('response', '').strip()
        if not summary_text:
            return jsonify({'status': 'error', 'error': 'LLM returned empty response'}), 500
        
        return jsonify({
            'status': 'success',
            'summary': summary_text,
            'model': 'qwen3:4b',
            'word_count': len(summary_text.split())
        })
    except requests.exceptions.Timeout:
        return jsonify({'status': 'error', 'error': 'LLM timeout - Mistral might be offline'}), 500
    except Exception as error:
        return jsonify({'status': 'error', 'error': str(error)}), 500


@app.route('/api/ask-ai-unconstrained', methods=['POST'])
def ask_github_ai_unconstrained():
    try:
        request_data = request.get_json() or {}
        landmark_name = request_data.get('landmark_name', 'this location')
        context_type = request_data.get('context_type', 'landmark')  
        user_question = request_data.get('question', '')
        landmark_metadata = request_data.get('metadata', {})
        
        if context_type == 'landmark':
            prompt = f"""Tell me about the history and significance of {landmark_name}. What should visitors know about this place? Provide interesting historical facts, cultural significance, and notable events associated with it."""
        else:
            metadata_text = ', '.join([f"{k}: {v}" for k, v in landmark_metadata.items()])
            prompt = f"""Question about {landmark_name} ({metadata_text}):

{user_question}

Please provide a detailed, informative answer based on your knowledge. This response is meant as supplementary information and may not be independently fact-checked."""
        
        result = call_github_ai_unconstrained(prompt, temperature=0.7)
        
        return jsonify({
            'status': result.get('status'),
            'answer': result.get('answer'),
            'error': result.get('error'),
            'source': 'GitHub Copilot (Unrestricted AI)',
            'disclaimer': 'This response was generated by AI without fact checking limitations and hallucination prevention . It may contain inaccuracies. Please verify information by researching other reliable sources.'
        })
        
    except Exception as error:
        return jsonify({'status': 'error', 'error': str(error)}), 500


@app.errorhandler(404)
def handle_not_found_error(error):
    return jsonify({'status': 'error', 'error': 'Not found'}), 404


@app.errorhandler(500)
def handle_internal_server_error(error):
    return jsonify({'status': 'error', 'error': 'Server error'}), 500


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
