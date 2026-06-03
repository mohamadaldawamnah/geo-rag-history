const CONFIG = {
    API_BASE_URL: 'http://localhost:5000',
    DEFAULT_LAT: 51.8985,
    DEFAULT_LON: -8.4756,
    DEFAULT_ZOOM: 14,
    SEARCH_RADIUS: 400,
    OVERPASS_URL: 'https://overpass-api.de/api/interpreter',
    NOMINATIM_URL: 'https://nominatim.openstreetmap.org/search',
};
let state = {
    landmarks: [],
    selected: null,
    markers: [],
    selectedMarker: null,
    cachedRegionCircle: null,
    cachedRegions: [],
    cachedTexts: {},
    cachedAnswers: {},
    isLoading: false,
    activeQueryId: 0,
    lastSearchName: null,
};

let map = L.map('map').setView([CONFIG.DEFAULT_LAT, CONFIG.DEFAULT_LON], CONFIG.DEFAULT_ZOOM);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap',
}).addTo(map);

function show_toast(msg, type = 'info') {
    const bgColor = type === 'error' ? '#dc3545' : type === 'success' ? '#28a745' : '#667eea';
    const toast = document.createElement('div');
    toast.style.cssText = `position: fixed; top: 20px; right: 20px; background: ${bgColor}; color: white; padding: 12px 20px; border-radius: 4px; z-index: 10000; animation: slideIn 0.3s ease-out;`;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease-out';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function format_dist(km) {
    return km < 1 ? (km * 1000).toFixed(0) + 'm' : km.toFixed(1) + 'km';
}

function html_escape(txt) {
    const s = String(txt ?? '');
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        const tabName = tab.dataset.tab;
        document.getElementById(`${tabName}-tab`).classList.add('active');
    });
});

function clear_all() {
    state.markers.forEach(m => map.removeLayer(m));
    state.markers = [];
    if (state.selectedMarker) {
        map.removeLayer(state.selectedMarker);
        state.selectedMarker = null;
    }
    state.landmarks = [];
    state.selected = null;
}

function clear_cached_region_circle() {
    if (state.cachedRegionCircle) {
        map.removeLayer(state.cachedRegionCircle);
        state.cachedRegionCircle = null;
    }
}

function highlight_cached_region(lat, lon, radiusMeters) {
    clear_cached_region_circle();
    state.cachedRegionCircle = L.circle([lat, lon], {
        radius: radiusMeters,
        color: '#d62839',
        weight: 2,
        fillColor: '#ef233c',
        fillOpacity: 0.2,
    }).addTo(map);
}

async function get_overpass_data(lat, lon, rad = CONFIG.SEARCH_RADIUS) {
    const q = `[out:json];(node["historic"](around:${rad},${lat},${lon});way["historic"](around:${rad},${lat},${lon});relation["historic"](around:${rad},${lat},${lon});node["tourism"="attraction"](around:${rad},${lat},${lon});way["tourism"="attraction"](around:${rad},${lat},${lon});relation["tourism"="attraction"](around:${rad},${lat},${lon});node["amenity"="place_of_worship"](around:${rad},${lat},${lon});way["amenity"="place_of_worship"](around:${rad},${lat},${lon});relation["amenity"="place_of_worship"](around:${rad},${lat},${lon}););out tags center;`;
    
    try {
        const resp = await fetch(CONFIG.OVERPASS_URL + '?data=' + encodeURIComponent(q));

        if (!resp.ok) {
            throw new Error(`Overpass HTTP ${resp.status}`);
        }

        const data = await resp.json();
        return data.elements || [];
    } catch (err) {
        throw err;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function show_offline_results_message() {
    document.getElementById('resultsList').innerHTML = `<div class="empty-state"><div class="empty-state-icon"></div><p>You are offline. Reconnect to query live landmarks.</p></div>`;
}

async function get_overpass_data_with_retry(lat, lon, queryId, rad = CONFIG.SEARCH_RADIUS) {
    let attempt = 0;

    if (!navigator.onLine) {
        show_offline_results_message();
        show_toast('You are offline. Live search is paused.', 'error');
        return null;
    }

    while (queryId === state.activeQueryId) {
        if (!navigator.onLine) {
            show_offline_results_message();
            show_toast('You are offline. Live search is paused.', 'error');
            return null;
        }

        attempt += 1;
        try {
            if (attempt > 1) {
                show_toast(`Retrying Overpass... attempt ${attempt}`, 'info');
            }
            return await get_overpass_data(lat, lon, rad);
        } catch (err) {
            if (queryId !== state.activeQueryId) {
                break;
            }

            const message = err?.message || 'Overpass request failed';
            show_toast(`${message}. Retrying...`, 'error');
            await sleep(2000);
        }
    }

    return [];
}

function build_landmarks(els, refLat, refLon) {
    const result = [];
    els.forEach(el => {
        const tags = el.tags || {};
        const name = tags.name || '(Unnamed)';
        let lat = el.lat;
        let lon = el.lon;
        
        if ((!lat || !lon) && el.center) {
            lat = el.center.lat;
            lon = el.center.lon;
        }
        
        if (!lat || !lon) return;
        
        const dist = haversine(refLat, refLon, lat, lon);
        result.push({
            id: `${el.type}-${el.id}`,
            name,
            lat,
            lon,
            distance: dist,
            osmType: el.type,
            osmId: el.id,
            tags,
            wikidata: tags.wikidata || null,
            wikipedia: tags.wikipedia || null,
        });
    });
    
    return result.sort((a, b) => a.distance - b.distance);
}

function create_custom_marker(lat, lon) {
    const customIcon = L.divIcon({
        html: '🏛️',
        className: 'history-marker',
        iconSize: [32, 32],
        iconAnchor: [16, 32],
        popupAnchor: [0, -32]
    });
    
    return L.marker([lat, lon], { icon: customIcon });
}

function create_selected_marker(lat, lon) {
    const selectedIcon = L.divIcon({
        html: '📍',
        className: 'selected-marker',
        iconSize: [76, 76],
        iconAnchor: [38, 76],
        popupAnchor: [0, -76]
    });
    
    return L.marker([lat, lon], { icon: selectedIcon });
}

function pin_selected_landmark() {
    if (state.selectedMarker) {
        map.removeLayer(state.selectedMarker);
        state.selectedMarker = null;
    }
    
    if (state.selected) {
        state.selectedMarker = create_selected_marker(state.selected.lat, state.selected.lon).addTo(map);
    }
}

async function fetch_text(landmark) {
    if (state.cachedTexts[landmark.id]) {
        return state.cachedTexts[landmark.id];
    }

    try {
        const res = await fetch(`${CONFIG.API_BASE_URL}/api/retrieve-text`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                landmark_name: landmark.name,
                wikidata_id: landmark.wikidata,
                wikipedia_url: landmark.wikipedia,
            }),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        state.cachedTexts[landmark.id] = data;
        return data;
    } catch (err) {
        return { status: 'error', text: null, error: err.message };
    }
}

async function fetch_wikipedia_and_summarize(landmark) {
    if (!landmark.wikidata) {
        return null;
    }

    try {
        const wikiRes = await fetch(`${CONFIG.API_BASE_URL}/api/fetch-wikipedia`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                wikidata_id: landmark.wikidata
            }),
        });

        if (!wikiRes.ok) throw new Error(`HTTP ${wikiRes.status}`);
        const wikiData = await wikiRes.json();

        if (!wikiData.text) return null;

        const summaryRes = await fetch(`${CONFIG.API_BASE_URL}/api/summarize-wiki`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                wikipedia_text: wikiData.text,
                landmark_name: landmark.name,
                max_words: 40
            }),
        });

        if (!summaryRes.ok) throw new Error(`HTTP ${summaryRes.status}`);
        const summaryData = await summaryRes.json();
        
        return summaryData;
    } catch (err) {
        return null;
    }
}

async function fetch_text_with_fallback(landmark) {
    const txt = await fetch_text(landmark);
    if (txt.status !== 'success' && landmark.wikidata) {
        const autoSummary = await fetch_wikipedia_and_summarize(landmark);
        if (autoSummary && autoSummary.status === 'success') {
            return {
                status: 'success',
                text: autoSummary.summary,
                isAutoGenerated: true
            };
        }
    }
    
    return txt;
}

async function generate_ans(landmark, q, yr = null) {
    const key = `${landmark.id}-${q}-${yr || 'all'}`;
    if (state.cachedAnswers[key]) {
        return state.cachedAnswers[key];
    }

    try {
        const res = await fetch(`${CONFIG.API_BASE_URL}/api/generate-answer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                landmark_name: landmark.name,
                landmark_metadata: landmark.tags,
                historical_text: state.cachedTexts[landmark.id]?.text || '',
                question: q,
                year: yr,
            }),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        state.cachedAnswers[key] = data;
        return data;
    } catch (err) {
        return { status: 'error', answer: null, error: err.message };
    }
}

function parse_optional_year(rawValue) {
    const normalized = String(rawValue ?? '').trim();
    if (!normalized) return null;

    const parsed = Number.parseInt(normalized, 10);
    if (!Number.isFinite(parsed)) return null;
    if (parsed < 1000 || parsed > 2100) return null;
    return parsed;
}

function render_list() {
    const list = document.getElementById('resultsList');
    
    if (state.landmarks.length === 0) {
        list.innerHTML = `<div class="empty-state"><div class="empty-state-icon"></div><p>No landmarks found. Try clicking elsewhere on the map.</p></div>`;
        return;
    }

    list.innerHTML = state.landmarks.map(lm => `
        <div class="landmark-item ${state.selected?.id === lm.id ? 'selected' : ''}" onclick="select_landmark('${lm.id}')">
            <div class="landmark-item-name">${html_escape(lm.name)}</div>
            <div class="landmark-item-type">${lm.osmType} • ${lm.tags.historic || lm.tags.tourism || lm.tags.amenity || 'landmark'}</div>
            <div class="landmark-item-dist">↔ ${format_dist(lm.distance)}</div>
        </div>
    `).join('');

    
    if (state.selected) {
        const selectedElement = list.querySelector('.landmark-item.selected');
        if (selectedElement) {
            selectedElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }
}

async function render_details(lm) {
    const panel = document.getElementById('detailsPanel');

    panel.innerHTML = `
        <div class="panel-section">
            <h3>Location & Info</h3>
            <div class="metadata-row"><span class="metadata-row-label">Name:</span><span>${html_escape(lm.name)}</span></div>
            <div class="metadata-row"><span class="metadata-row-label">Type:</span><span>${lm.osmType}</span></div>
            <div class="metadata-row"><span class="metadata-row-label">Coords:</span><span>${lm.lat.toFixed(4)}, ${lm.lon.toFixed(4)}</span></div>
            <div class="metadata-row"><span class="metadata-row-label">Distance:</span><span>${format_dist(lm.distance)}</span></div>
            <div class="metadata-row"><span class="metadata-row-label">OSM ID:</span><span>${lm.osmId}</span></div>
        </div>

        <div class="panel-section">
            <h3>Tags</h3>
            <div class="tags-grid">
                ${lm.wikidata ? `<div class="tag"><span class="tag-key">wikidata:</span><span>${html_escape(lm.wikidata)}</span></div>` : ''}
                ${Object.entries(lm.tags).map(([k, v]) => `<div class="tag"><span class="tag-key">${html_escape(k)}:</span><span>${html_escape(v)}</span></div>`).join('')}
            </div>
        </div>

        <div class="panel-section">
            <h3>History</h3>
            <div id="contextStatus" class="context-status loading"><span class="loading-spinner"></span> Loading...</div>
            <div id="contextText" class="context-text" style="display:none;"></div>
        </div>
    `;

    const txt = await fetch_text_with_fallback(lm);
    const status = document.getElementById('contextStatus');
    const ctx = document.getElementById('contextText');

    
    show_github_ai_button('details', lm);

    if (txt.status === 'success' && txt.text) {
        const badge = txt.isAutoGenerated ? 'auto-generated' : 'ok';
        const badgeText = txt.isAutoGenerated ? '🤖 Auto-Generated from Wikipedia' : 'Got it';
        status.innerHTML = `<span class="status-badge ${badge}">${badgeText}</span>`;
        ctx.textContent = txt.text;
        ctx.style.display = 'block';
    } else if (txt.status === 'no_data') {
        status.innerHTML = `<span class="status-badge warning">No text</span>`;
    } else {
        status.innerHTML = `<span class="status-badge error">Error: ${txt.error || 'unknown'}</span>`;
    }
}

async function render_rag(lm) {
    const panel = document.getElementById('ragPanel');

    panel.innerHTML = `
        <div class="panel-section">
            <h3>Ask Something</h3>
            <input type="text" class="question-input" id="questionInput" placeholder="e.g., What happened here in 1850?" />
            <input type="number" class="year-input" id="yearInput" placeholder="Year (optional)" min="1000" max="2100" />
            <button onclick="gen_answer(event)" style="width: 100%;">Generate</button>
        </div>

        <div class="panel-section">
            <h3>Prompt Template</h3>
            <div id="promptTemplate" class="prompt-builder"></div>
            <p style="font-size: 0.8em; color: #666; margin-top: 8px;">Your actual question and year will be added when you click Generate.</p>
        </div>

        <div id="answerSection" style="display: none;">
            <div class="panel-section">
                <h3>Answer</h3>
                <div id="answerText" class="answer-text"></div>
                <div id="answerSource" class="answer-source"></div>
            </div>
        </div>
    `;

    const txt = await fetch_text(lm);
    const prompt = build_prompt(lm, txt, '[your question]', '[optional year]');
    document.getElementById('promptTemplate').textContent = prompt;
}

function build_prompt(lm, txt, q = null, yr = null) {
    const sys = `You are a historical fact extractor. CRITICAL RULES:
1. Extract ONLY sentences that exist in the provided context
2. Do NOT make up, invent, or infer any information
3. If the requested year is NOT mentioned in the context, respond: "No information for that time period in the source material"
4. If the question cannot be answered from the context, say so explicitly
5. Never generate plausible-sounding but fabricated history
6. Provide all relevant details from the context without shortening.`;
    const meta = Object.entries(lm.tags).map(([k, v]) => `${k}: ${v}`).join('\n');
    const context = txt.status === 'success' && txt.text ? txt.text : '[no text available]';
    let promptText = `SYSTEM INSTRUCTIONS:\n${sys}\n\nLANDMARK:\nName: ${lm.name}\nType: ${lm.osmType}\nCoords: ${lm.lat.toFixed(4)}, ${lm.lon.toFixed(4)}\n\nTAGS:\n${meta}\n\nHISTORICAL CONTEXT:\n${context}`;
    if (q) {
        promptText += `\n\nQUESTION: ${q}`;
    }
    if (yr) {
        promptText += `\nYEAR: ${yr} - Only answer if this year appears in the context above.`;
    }
    promptText += `\n\nREQUIREMENT: Your answer must be a direct quote or paraphrase from the context above. Do not invent facts.`;
    return promptText;
}

async function gen_answer(event) {
    if (!state.selected) return;

    const q = document.getElementById('questionInput')?.value || '';
    const yrInput = document.getElementById('yearInput')?.value;
    const yr = parse_optional_year(yrInput);

    if (!q) {
        show_toast('Enter a question', 'error');
        return;
    }

    const btn = event.target;
    btn.disabled = true;
    btn.textContent = 'Thinking...';

    try {
        const ans = await generate_ans(state.selected, q, yr);
        const sec = document.getElementById('answerSection');

        if (ans.status === 'success' && ans.answer) {
            document.getElementById('answerText').textContent = ans.answer;
            document.getElementById('answerSource').innerHTML = `<strong>Source:</strong> Wikipedia (extracted via local LLM)`;
            sec.style.display = 'block';

            show_github_ai_button('rag', state.selected, q, yr);
            
            show_toast('Done!', 'success');
        } else {
            document.getElementById('answerText').textContent = `Error: ${ans.error || 'failed'}`;
            sec.style.display = 'block';
            
            show_github_ai_button('rag', state.selected, q, yr);
            show_toast('Failed to generate, but you can try asking AI', 'error');
        }
    } finally {
        btn.disabled = false;
        btn.textContent = 'Generate';
    }
}

async function ask_github_ai(context_type, landmark_name, question = null, year = null) {
    try {
        const request_payload = {
            landmark_name: landmark_name,
            context_type: context_type,
            question: question || '',
            metadata: state.selected ? state.selected.tags : {}
        };

        const response = await fetch(`${CONFIG.API_BASE_URL}/api/ask-ai-unconstrained`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request_payload)
        });

        const data = await response.json();
        return data;
    } catch (error) {
        return { status: 'error', error: error.message };
    }
}

function show_github_ai_button(tab_type, landmark, question = null, year = null) {
    if (tab_type === 'details') {
        const status_elem = document.getElementById('contextStatus');
        if (status_elem) {
            const parent = status_elem.parentElement;
            const existing_button = parent.querySelector('.github-ai-button');
            if (existing_button) {
                return;
            }
            
            const button_container = document.createElement('div');
            button_container.className = 'github-ai-button';
            button_container.style.cssText = 'margin-top: 12px; padding-top: 12px; border-top: 1px solid #ddd;';
            
            const button = document.createElement('button');
            button.textContent = 'Ask Unrestricted AI';
            button.style.cssText = 'width: 100%; padding: 10px; background: #f0ad4e; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;';
            button.addEventListener('click', () => handle_ask_github_ai(button, 'details', landmark.name, question, year));
            
            const warning = document.createElement('p');
            warning.textContent = 'This will ask GitHub Copilot without fact-checking constraints';
            warning.style.cssText = 'font-size: 0.75em; color: #999; margin-top: 8px; text-align: center;';
            
            button_container.appendChild(button);
            button_container.appendChild(warning);
            parent.appendChild(button_container);
        }
    } else if (tab_type === 'rag') {
        const answer_section = document.getElementById('answerSection');
        if (answer_section) {
            const existing_button = answer_section.querySelector('.github-ai-button');
            if (existing_button) {
                return;
            }
            
            const button_container = document.createElement('div');
            button_container.className = 'github-ai-button';
            button_container.style.cssText = 'margin-top: 12px; padding-top: 12px; border-top: 1px solid #ddd;';
            
            const button = document.createElement('button');
            button.textContent = 'Ask Unrestricted AI';
            button.style.cssText = 'width: 100%; padding: 10px; background: #f0ad4e; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;';
            button.addEventListener('click', () => handle_ask_github_ai(button, 'rag', landmark.name, question, year));
            
            const warning = document.createElement('p');
            warning.textContent = 'This will ask GitHub Copilot without fact-checking constraints';
            warning.style.cssText = 'font-size: 0.75em; color: #999; margin-top: 8px; text-align: center;';
            
            button_container.appendChild(button);
            button_container.appendChild(warning);
            answer_section.appendChild(button_container);
        }
    }
}

async function handle_ask_github_ai(btn, tab_type, landmark_name, question = null, year = null) {
    btn.disabled = true;
    btn.textContent = 'Asking AI...';

    try {
        const result = await ask_github_ai(tab_type === 'details' ? 'landmark' : 'question', landmark_name, question, year);

        if (result.status === 'success') {
            if (tab_type === 'details') {
                document.getElementById('contextText').textContent = result.answer;
                document.getElementById('contextText').style.display = 'block';
                document.getElementById('contextStatus').innerHTML = `
                    <span class="status-badge warning">AI-Generated (Unrestricted)</span>
                    <p style="font-size: 0.8em; color: #dc3545; margin-top: 8px;">
                        ⚠️ <strong>Warning:</strong> ${result.disclaimer}
                    </p>
                `;
            } else {
                document.getElementById('answerText').textContent = result.answer;
                document.getElementById('answerSource').innerHTML = `
                    <strong>Source:</strong> ${result.source}<br/>
                    <p style="font-size: 0.8em; color: #dc3545; margin-top: 8px;">
                        ⚠️ <strong>Warning:</strong> ${result.disclaimer}
                    </p>
                `;
            }
            show_toast('Got answer from AI!', 'success');
        } else {
            show_toast(`Error: ${result.error || 'unknown'}`, 'error');
        }
    } finally {
        btn.disabled = false;
        btn.textContent = 'Ask Unrestricted AI';
    }
}

async function select_landmark(id) {
    state.selected = state.landmarks.find(l => l.id === id);
    if (!state.selected) return;

    render_list();
    map.flyTo([state.selected.lat, state.selected.lon], 16);
    pin_selected_landmark();
    
    await render_details(state.selected);
    await render_rag(state.selected);

    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector('[data-tab="details"]').classList.add('active');
    document.getElementById('details-tab').classList.add('active');
}

async function search_place(name) {
    if (!name.trim()) {
        return;
    }
    try {
        const resp = await fetch(`${CONFIG.NOMINATIM_URL}?q=${encodeURIComponent(name)}&format=json&limit=1`);
        const data = await resp.json();

        if (data.length === 0) {
            show_toast(`"${name}" not found`, 'error');
            return;
        }
        const res = data[0];
        const lat = parseFloat(res.lat);
        const lon = parseFloat(res.lon);
        state.lastSearchName = (name || '').trim() || null;

        map.flyTo([lat, lon], 14);
        query_landmarks(lat, lon);
        show_toast(`Found: ${res.display_name}`, 'success');
    } catch (err) {
        show_toast('Search failed', 'error');
    }
}

async function query_landmarks(lat, lon) {
    state.activeQueryId += 1;
    const queryId = state.activeQueryId;

    clear_all();

    if (!navigator.onLine) {
        show_offline_results_message();
        show_toast('You are offline. Reconnect and try again.', 'error');
        return;
    }

    document.getElementById('resultsList').innerHTML = `<div class="empty-state"><div class="loading-spinner"></div><p>Querying Overpass...</p></div>`;

    const els = await get_overpass_data_with_retry(lat, lon, queryId);
    if (queryId !== state.activeQueryId) {
        return;
    }

    if (els === null) {
        return;
    }

    state.landmarks = build_landmarks(els, lat, lon);

    if (state.landmarks.length === 0) {
        document.getElementById('resultsList').innerHTML = `<div class="empty-state"><div class="empty-state-icon"></div><p>No landmarks here.</p></div>`;
        return;
    }

    state.landmarks.forEach(lm => {
        const marker = create_custom_marker(lm.lat, lm.lon).addTo(map);
        marker.on('click', () => select_landmark(lm.id));
        state.markers.push(marker);
    });

    render_list();
    show_toast(`Found ${state.landmarks.length} landmarks`, 'success');
}

async function cache_current_region() {
    try {
        let landmarks_to_cache = state.landmarks;
        const center = map.getCenter();
        const radiusMeters = CONFIG.SEARCH_RADIUS;
        if (!landmarks_to_cache || landmarks_to_cache.length === 0) {
            const els = await get_overpass_data(center.lat, center.lng);
            landmarks_to_cache = build_landmarks(els, center.lat, center.lng);
        }

        if (!landmarks_to_cache || landmarks_to_cache.length === 0) {
            show_toast('No landmarks to cache in this region', 'error');
            return;
        }

        const inferredRegionName = state.lastSearchName || `Area ${center.lat.toFixed(3)}, ${center.lng.toFixed(3)}`;
        const resp = await fetch(`${CONFIG.API_BASE_URL}/api/cache-landmarks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                landmarks: landmarks_to_cache,
                region_name: inferredRegionName,
                center_lat: center.lat,
                center_lon: center.lng,
                radius_m: radiusMeters,
            }),
        });
        const data = await resp.json();
        if (!resp.ok || data.status !== 'success') {
            throw new Error(data.error || `HTTP ${resp.status}`);
        }

        show_toast(`Cached ${data.saved_count} landmarks for offline use`, 'success');
        await load_cached_regions();
    } catch (err) {
        show_toast(`Cache failed: ${err.message || 'unknown error'}`, 'error');
    }
}

function render_cached_regions() {
    const list = document.getElementById('cachedRegionsList');
    if (!list) return;

    if (!state.cachedRegions.length) {
        list.innerHTML = `<div class="empty-state"><div class="empty-state-icon"></div><p>No cached regions yet. Use Cache Region first.</p></div>`;
        return;
    }

    list.innerHTML = state.cachedRegions.map((region, index) => {
        const regionName = html_escape(region.name || 'Cached Area');
        const radiusText = Number(region.radius_m || 0);
        const landmarkCount = Number(region.landmark_count || 0);
        const cachedAt = html_escape(region.cached_at || 'recently');
        return `
            <div class="cached-region-item" onclick="open_cached_region(${index})">
                <div class="cached-region-name">${regionName}</div>
                <div class="cached-region-meta">Radius: ${radiusText}m • Landmarks: ${landmarkCount}</div>
                <div class="cached-region-meta">Cached at: ${cachedAt}</div>
            </div>
        `;
    }).join('');
}

async function load_cached_regions() {
    try {
        const resp = await fetch(`${CONFIG.API_BASE_URL}/api/cached-regions?limit=100`);
        const data = await resp.json();
        if (!resp.ok || data.status !== 'success') {
            throw new Error(data.error || `HTTP ${resp.status}`);
        }

        state.cachedRegions = Array.isArray(data.regions) ? data.regions : [];
        render_cached_regions();
    } catch (err) {
        const list = document.getElementById('cachedRegionsList');
        if (list) {
            list.innerHTML = `<div class="empty-state"><div class="empty-state-icon"></div><p>Could not load cached regions.</p></div>`;
        }
    }
}

async function load_cached_landmarks_for_area(lat, lon, radiusMeters) {
    const radiusKm = Math.max(0.2, radiusMeters / 1000);
    const resp = await fetch(
        `${CONFIG.API_BASE_URL}/api/cached-landmarks?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&radius_km=${encodeURIComponent(radiusKm)}`
    );
    const data = await resp.json();
    if (!resp.ok || data.status !== 'success') {
        throw new Error(data.error || `HTTP ${resp.status}`);
    }

    clear_all();
    state.landmarks = Array.isArray(data.landmarks) ? data.landmarks : [];

    if (state.landmarks.length === 0) {
        document.getElementById('resultsList').innerHTML = `<div class="empty-state"><div class="empty-state-icon"></div><p>No cached landmarks for this region.</p></div>`;
        return 0;
    }

    state.landmarks.forEach(lm => {
        const marker = create_custom_marker(lm.lat, lm.lon).addTo(map);
        marker.on('click', () => select_landmark(lm.id));
        state.markers.push(marker);
    });
    render_list();
    return state.landmarks.length;
}

async function open_cached_region(index) {
    const region = state.cachedRegions[index];
    if (!region) return;

    const lat = Number(region.center_lat);
    const lon = Number(region.center_lon);
    const radiusMeters = Number(region.radius_m || CONFIG.SEARCH_RADIUS);

    map.flyTo([lat, lon], 14);
    highlight_cached_region(lat, lon, radiusMeters);

    try {
        const count = await load_cached_landmarks_for_area(lat, lon, radiusMeters);
        show_toast(`Loaded ${count} cached landmarks from ${region.name}`, 'success');
    } catch (err) {
        show_toast(`Load cached failed: ${err.message || 'unknown error'}`, 'error');
    }

    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector('[data-tab="results"]').classList.add('active');
    document.getElementById('results-tab').classList.add('active');
}

async function show_cached_region() {
    try {
        const center = map.getCenter();
        const loadedCount = await load_cached_landmarks_for_area(center.lat, center.lng, CONFIG.SEARCH_RADIUS);
        highlight_cached_region(center.lat, center.lng, CONFIG.SEARCH_RADIUS);
        if (loadedCount === 0) {
            show_toast('No cached landmarks nearby', 'error');
            return;
        }

        show_toast(`Loaded ${loadedCount} cached landmarks`, 'success');
    } catch (err) {
        show_toast(`Load cached failed: ${err.message || 'unknown error'}`, 'error');
    }
}



function locate_me() {
    if (!navigator.geolocation) {
        show_toast('Geolocation not supported', 'error');
        return;
    }

    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const lat = pos.coords.latitude;
            const lon = pos.coords.longitude;
            map.flyTo([lat, lon], 14);
            query_landmarks(lat, lon);
            show_toast('Found your location', 'success');
        },
        (err) => {
            show_toast('Geolocation failed', 'error');
        }
    );
}

function reset_map() {
    clear_all();
    clear_cached_region_circle();
    document.getElementById('resultsList').innerHTML = `<div class="empty-state"><div class="empty-state-icon"></div><p>Click the map to find landmarks.</p></div>`;
    document.getElementById('detailsPanel').innerHTML = `<div class="empty-state"><div class="empty-state-icon"></div><p>Select a landmark.</p></div>`;
    document.getElementById('ragPanel').innerHTML = `<div class="empty-state"><div class="empty-state-icon"></div><p>Select a landmark.</p></div>`;
    map.flyTo([CONFIG.DEFAULT_LAT, CONFIG.DEFAULT_LON], CONFIG.DEFAULT_ZOOM);
    show_toast('Reset', 'success');
}

function close_intro_overlay() {
    const overlay = document.getElementById('introOverlay');
    if (!overlay) return;

    overlay.style.display = 'none';
    document.body.classList.remove('intro-active');
    setTimeout(() => {
        map.invalidateSize();
    }, 80);
}

function toggle_sidebar() {
    const main = document.querySelector('.main');
    const toggle = document.getElementById('sidebarToggle');
    if (!main || !toggle) return;

    const isCollapsed = main.classList.toggle('sidebar-collapsed');
    toggle.textContent = isCollapsed ? '>' : '<';
    toggle.title = isCollapsed ? 'Show sidebar' : 'Hide sidebar';
    toggle.setAttribute('aria-label', isCollapsed ? 'Show sidebar' : 'Hide sidebar');

    setTimeout(() => {
        map.invalidateSize();
    }, 320);
}

document.getElementById('searchInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') search_place(e.target.value);
});

document.getElementById('gpsBtn').addEventListener('click', locate_me);
document.getElementById('resetBtn').addEventListener('click', reset_map);
document.getElementById('cacheBtn').addEventListener('click', cache_current_region);
document.getElementById('showCachedBtn').addEventListener('click', show_cached_region);
document.getElementById('sidebarToggle').addEventListener('click', toggle_sidebar);
if (document.getElementById('startAppBtn')) {
    document.getElementById('startAppBtn').addEventListener('click', close_intro_overlay);
}

load_cached_regions();

map.on('click', (e) => {
    clear_cached_region_circle();
    query_landmarks(e.latlng.lat, e.latlng.lng);
});

window.open_cached_region = open_cached_region;
