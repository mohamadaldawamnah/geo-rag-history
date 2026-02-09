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
    cachedTexts: {},
    cachedAnswers: {},
    isLoading: false,
};

// init map
let map = L.map('map').setView([CONFIG.DEFAULT_LAT, CONFIG.DEFAULT_LON], CONFIG.DEFAULT_ZOOM);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap',
}).addTo(map);

// toast notifications
function showToast(msg, type = 'info') {
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

function formatDist(km) {
    return km < 1 ? (km * 1000).toFixed(0) + 'm' : km.toFixed(1) + 'km';
}

function htmlEscape(txt) {
    return txt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// tab switching
document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        const tabName = tab.dataset.tab;
        document.getElementById(`${tabName}-tab`).classList.add('active');
    });
});

function clearAll() {
    state.markers.forEach(m => map.removeLayer(m));
    state.markers = [];
    state.landmarks = [];
    state.selected = null;
}

async function getOverpassData(lat, lon, rad = CONFIG.SEARCH_RADIUS) {
    const q = `[out:json];(node["historic"](around:${rad},${lat},${lon});way["historic"](around:${rad},${lat},${lon});relation["historic"](around:${rad},${lat},${lon});node["tourism"="attraction"](around:${rad},${lat},${lon});way["tourism"="attraction"](around:${rad},${lat},${lon});relation["tourism"="attraction"](around:${rad},${lat},${lon});node["amenity"="place_of_worship"](around:${rad},${lat},${lon});way["amenity"="place_of_worship"](around:${rad},${lat},${lon});relation["amenity"="place_of_worship"](around:${rad},${lat},${lon}););out tags center;`;
    
    try {
        const resp = await fetch(CONFIG.OVERPASS_URL + '?data=' + encodeURIComponent(q));
        const data = await resp.json();
        return data.elements || [];
    } catch (err) {
        console.error('overpass error:', err);
        showToast('Failed to query Overpass API', 'error');
        return [];
    }
}

function buildLandmarks(els, refLat, refLon) {
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

async function fetchText(landmark) {
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
        console.error('text fetch error:', err);
        return { status: 'error', text: null, error: err.message };
    }
}

async function generateAns(landmark, q, yr = null) {
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
                historical_text: state.cachedTexts[landmark.id]?.text,
                question: q,
                year: yr,
            }),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        state.cachedAnswers[key] = data;
        return data;
    } catch (err) {
        console.error('answer gen error:', err);
        return { status: 'error', answer: null, error: err.message };
    }
}

function renderList() {
    const list = document.getElementById('resultsList');
    
    if (state.landmarks.length === 0) {
        list.innerHTML = `<div class="empty-state"><div class="empty-state-icon"></div><p>No landmarks found. Try clicking elsewhere on the map.</p></div>`;
        return;
    }

    list.innerHTML = state.landmarks.map(lm => `
        <div class="landmark-item ${state.selected?.id === lm.id ? 'selected' : ''}" onclick="selectLandmark('${lm.id}')">
            <div class="landmark-item-name">${htmlEscape(lm.name)}</div>
            <div class="landmark-item-type">${lm.osmType} • ${lm.tags.historic || lm.tags.tourism || lm.tags.amenity || 'landmark'}</div>
            <div class="landmark-item-dist">↔ ${formatDist(lm.distance)}</div>
        </div>
    `).join('');
}

async function renderDetails(lm) {
    const panel = document.getElementById('detailsPanel');

    panel.innerHTML = `
        <div class="panel-section">
            <h3>Location & Info</h3>
            <div class="metadata-row"><span class="metadata-row-label">Name:</span><span>${htmlEscape(lm.name)}</span></div>
            <div class="metadata-row"><span class="metadata-row-label">Type:</span><span>${lm.osmType}</span></div>
            <div class="metadata-row"><span class="metadata-row-label">Coords:</span><span>${lm.lat.toFixed(4)}, ${lm.lon.toFixed(4)}</span></div>
            <div class="metadata-row"><span class="metadata-row-label">Distance:</span><span>${formatDist(lm.distance)}</span></div>
            <div class="metadata-row"><span class="metadata-row-label">OSM ID:</span><span>${lm.osmId}</span></div>
        </div>

        <div class="panel-section">
            <h3>Tags</h3>
            <div class="tags-grid">
                ${Object.entries(lm.tags).map(([k, v]) => `<div class="tag"><span class="tag-key">${htmlEscape(k)}:</span><span>${htmlEscape(v)}</span></div>`).join('')}
            </div>
        </div>

        <div class="panel-section">
            <h3>History</h3>
            <div id="contextStatus" class="context-status loading"><span class="loading-spinner"></span> Loading...</div>
            <div id="contextText" class="context-text" style="display:none;"></div>
        </div>
    `;

    const txt = await fetchText(lm);
    const status = document.getElementById('contextStatus');
    const ctx = document.getElementById('contextText');

    if (txt.status === 'success' && txt.text) {
        status.innerHTML = `<span class="status-badge ok">Got it</span>`;
        ctx.textContent = txt.text;
        ctx.style.display = 'block';
    } else if (txt.status === 'no_data') {
        status.innerHTML = `<span class="status-badge warning">No text</span>`;
    } else {
        status.innerHTML = `<span class="status-badge error">Error: ${txt.error || 'unknown'}</span>`;
    }
}

async function renderRAG(lm) {
    const panel = document.getElementById('ragPanel');

    panel.innerHTML = `
        <div class="panel-section">
            <h3>Ask Something</h3>
            <input type="text" class="question-input" id="questionInput" placeholder="e.g., What happened here in 1850?" />
            <input type="number" class="year-input" id="yearInput" placeholder="Year (optional)" min="1000" max="2100" />
            <button onclick="genAnswer()" style="width: 100%;">Generate</button>
        </div>

        <div class="panel-section">
            <h3>Prompt</h3>
            <div id="promptTemplate" class="prompt-builder"></div>
        </div>

        <div id="answerSection" style="display: none;">
            <div class="panel-section">
                <h3>Answer</h3>
                <div id="answerText" class="answer-text"></div>
                <div id="answerSource" class="answer-source"></div>
            </div>
        </div>
    `;

    const txt = await fetchText(lm);
    const prompt = buildPrompt(lm, txt);
    document.getElementById('promptTemplate').textContent = prompt;
}

function buildPrompt(lm, txt) {
    const sys = `You are a historical assistant. Answer ONLY using the provided context. If you don't know, say so. Don't make stuff up.`;
    
    const meta = Object.entries(lm.tags)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');

    const context = txt.status === 'success' && txt.text ? txt.text : '[No text available]';

    return `SYSTEM:
${sys}

LANDMARK:
Name: ${lm.name}
Type: ${lm.osmType}
Coords: ${lm.lat.toFixed(4)}, ${lm.lon.toFixed(4)}

TAGS:
${meta}

CONTEXT:
${context}

Answer based only on the above info.`;
}

async function genAnswer() {
    if (!state.selected) return;

    const q = document.getElementById('questionInput')?.value || '';
    const yr = document.getElementById('yearInput')?.value || null;

    if (!q) {
        showToast('Enter a question', 'error');
        return;
    }

    const btn = event.target;
    btn.disabled = true;
    btn.textContent = 'Thinking...';

    try {
        const ans = await generateAns(state.selected, q, yr ? parseInt(yr) : null);
        const sec = document.getElementById('answerSection');

        if (ans.status === 'success' && ans.answer) {
            document.getElementById('answerText').textContent = ans.answer;
            document.getElementById('answerSource').innerHTML = `<strong>Source:</strong> Local LLM (Ollama)`;
            sec.style.display = 'block';
            showToast('Done!', 'success');
        } else {
            document.getElementById('answerText').textContent = `Error: ${ans.error || 'failed'}`;
            sec.style.display = 'block';
            showToast('Failed to generate', 'error');
        }
    } finally {
        btn.disabled = false;
        btn.textContent = 'Generate';
    }
}

async function selectLandmark(id) {
    state.selected = state.landmarks.find(l => l.id === id);
    if (!state.selected) return;

    renderList();
    map.flyTo([state.selected.lat, state.selected.lon], 16);
    
    await renderDetails(state.selected);
    await renderRAG(state.selected);

    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector('[data-tab="details"]').classList.add('active');
    document.getElementById('details-tab').classList.add('active');
}

async function searchPlace(name) {
    if (!name.trim()) return;

    try {
        const resp = await fetch(`${CONFIG.NOMINATIM_URL}?q=${encodeURIComponent(name)}&format=json&limit=1`);
        const data = await resp.json();

        if (data.length === 0) {
            showToast(`"${name}" not found`, 'error');
            return;
        }

        const res = data[0];
        const lat = parseFloat(res.lat);
        const lon = parseFloat(res.lon);

        map.flyTo([lat, lon], 14);
        queryLandmarks(lat, lon);
        showToast(`Found: ${res.display_name}`, 'success');
    } catch (err) {
        console.error('search error:', err);
        showToast('Search failed', 'error');
    }
}

async function queryLandmarks(lat, lon) {
    clearAll();
    document.getElementById('resultsList').innerHTML = `<div class="empty-state"><div class="loading-spinner"></div><p>Querying Overpass...</p></div>`;

    const els = await getOverpassData(lat, lon);
    state.landmarks = buildLandmarks(els, lat, lon);

    if (state.landmarks.length === 0) {
        document.getElementById('resultsList').innerHTML = `<div class="empty-state"><div class="empty-state-icon"></div><p>No landmarks here.</p></div>`;
        return;
    }

    state.landmarks.forEach(lm => {
        const marker = L.marker([lm.lat, lm.lon]).addTo(map);
        marker.on('click', () => selectLandmark(lm.id));
        state.markers.push(marker);
    });

    renderList();
    showToast(`Found ${state.landmarks.length} landmarks`, 'success');
}



function locateMe() {
    if (!navigator.geolocation) {
        showToast('Geolocation not supported', 'error');
        return;
    }

    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const lat = pos.coords.latitude;
            const lon = pos.coords.longitude;
            map.flyTo([lat, lon], 14);
            queryLandmarks(lat, lon);
            showToast('Found your location', 'success');
        },
        (err) => {
            console.error('geo error:', err);
            showToast('Geolocation failed', 'error');
        }
    );
}

function resetMap() {
    clearAll();
    document.getElementById('resultsList').innerHTML = `<div class="empty-state"><div class="empty-state-icon"></div><p>Click the map to find landmarks.</p></div>`;
    document.getElementById('detailsPanel').innerHTML = `<div class="empty-state"><div class="empty-state-icon"></div><p>Select a landmark.</p></div>`;
    document.getElementById('ragPanel').innerHTML = `<div class="empty-state"><div class="empty-state-icon"></div><p>Select a landmark.</p></div>`;
    map.flyTo([CONFIG.DEFAULT_LAT, CONFIG.DEFAULT_LON], CONFIG.DEFAULT_ZOOM);
    showToast('Reset', 'success');
}

document.getElementById('searchInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') searchPlace(e.target.value);
});

document.getElementById('gpsBtn').addEventListener('click', locateMe);
document.getElementById('resetBtn').addEventListener('click', resetMap);

map.on('click', (e) => {
    queryLandmarks(e.latlng.lat, e.latlng.lng);
});

console.log('App loaded. Click the map to start.');
