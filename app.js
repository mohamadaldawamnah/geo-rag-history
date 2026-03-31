const CONFIG = {
    API_BASE_URL: 'http://localhost:5000',
    DEFAULT_LAT: 51.8985,
    DEFAULT_LON: -8.4756,
    DEFAULT_ZOOM: 14,
    SEARCH_RADIUS: 800,
    OVERPASS_URL: 'https://overpass-api.de/api/interpreter',
    NOMINATIM_URL: 'https://nominatim.openstreetmap.org/search',
};
let state = {
    landmarks: [],
    selected: null,
    markers: [],
    selectedMarker: null,
    cachedTexts: {},
    cachedAnswers: {},
    isLoading: false,
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
        show_toast('Failed to query Overpass API', 'error');
        return [];
    }
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
        iconSize: [50, 50],
        iconAnchor: [25, 50],
        popupAnchor: [0, -50]
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
        // Get Wikipedia article via Wikidata ID
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

    // Scroll selected item into view
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

    if (txt.status === 'success' && txt.text) {
        const badge = txt.isAutoGenerated ? 'auto-generated' : 'ok';
        const badgeText = txt.isAutoGenerated ? '🤖 Auto-Generated from Wikipedia' : 'Got it';
        status.innerHTML = `<span class="status-badge ${badge}">${badgeText}</span>`;
        ctx.textContent = txt.text;
        ctx.style.display = 'block';
    } else if (txt.status === 'no_data') {
        status.innerHTML = `<span class="status-badge warning">No text</span>`;
        show_github_ai_button('details', lm);
    } else {
        status.innerHTML = `<span class="status-badge error">Error: ${txt.error || 'unknown'}</span>`;
        show_github_ai_button('details', lm);
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
5. Never generate plausible-sounding but fabricated history`;
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
    const yr = document.getElementById('yearInput')?.value || null;

    if (!q) {
        show_toast('Enter a question', 'error');
        return;
    }

    const btn = event.target;
    btn.disabled = true;
    btn.textContent = 'Thinking...';

    try {
        const ans = await generate_ans(state.selected, q, yr ? parseInt(yr) : null);
        const sec = document.getElementById('answerSection');

        if (ans.status === 'success' && ans.answer) {
            document.getElementById('answerText').textContent = ans.answer;
            document.getElementById('answerSource').innerHTML = `<strong>Source:</strong> Wikipedia (extracted via local LLM)`;
            sec.style.display = 'block';
            
            // Show GitHub AI button if answer is insufficient (very short)
            const wordCount = ans.answer.split(/\s+/).length;
            if (wordCount < 20) {
                show_github_ai_button('rag', state.selected, q, yr ? parseInt(yr) : null);
            }
            
            show_toast('Done!', 'success');
        } else {
            document.getElementById('answerText').textContent = `Error: ${ans.error || 'failed'}`;
            sec.style.display = 'block';
            
            show_github_ai_button('rag', state.selected, q, yr ? parseInt(yr) : null);
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

        map.flyTo([lat, lon], 14);
        query_landmarks(lat, lon);
        show_toast(`Found: ${res.display_name}`, 'success');
    } catch (err) {
        show_toast('Search failed', 'error');
    }
}

async function query_landmarks(lat, lon) {
    clear_all();
    document.getElementById('resultsList').innerHTML = `<div class="empty-state"><div class="loading-spinner"></div><p>Querying Overpass...</p></div>`;

    const els = await get_overpass_data(lat, lon);
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
    document.getElementById('resultsList').innerHTML = `<div class="empty-state"><div class="empty-state-icon"></div><p>Click the map to find landmarks.</p></div>`;
    document.getElementById('detailsPanel').innerHTML = `<div class="empty-state"><div class="empty-state-icon"></div><p>Select a landmark.</p></div>`;
    document.getElementById('ragPanel').innerHTML = `<div class="empty-state"><div class="empty-state-icon"></div><p>Select a landmark.</p></div>`;
    map.flyTo([CONFIG.DEFAULT_LAT, CONFIG.DEFAULT_LON], CONFIG.DEFAULT_ZOOM);
    show_toast('Reset', 'success');
}

document.getElementById('searchInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') search_place(e.target.value);
});

document.getElementById('gpsBtn').addEventListener('click', locate_me);
document.getElementById('resetBtn').addEventListener('click', reset_map);

map.on('click', (e) => {
    query_landmarks(e.latlng.lat, e.latlng.lng);
});
