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

let map = L.map('map').setView([CONFIG.DEFAULT_LAT, CONFIG.DEFAULT_LON], CONFIG.DEFAULT_ZOOM);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap',
}).addTo(map);

function show_toast(message, notification_type = 'info') {
    let background_color;
    
    if (notification_type === 'error') {
        background_color = '#dc3545';
    } else if (notification_type === 'success') {
        background_color = '#28a745';
    } else {
        background_color = '#667eea';
    }
    
    const toast_element = document.createElement('div');
    toast_element.style.cssText = `position: fixed; top: 20px; right: 20px; background: ${background_color}; color: white; padding: 12px 20px; border-radius: 4px; z-index: 10000; animation: slideIn 0.3s ease-out;`;
    toast_element.textContent = message;
    document.body.appendChild(toast_element);
    
    setTimeout(function() {
        toast_element.style.animation = 'slideOut 0.3s ease-out';
        setTimeout(function() {
            toast_element.remove();
        }, 300);
    }, 3000);
}

function calculate_distance_between_points(latitude1, longitude1, latitude2, longitude2) {
    const earth_radius_km = 6371;
    
    const latitude_difference = (latitude2 - latitude1) * Math.PI / 180;
    const longitude_difference = (longitude2 - longitude1) * Math.PI / 180;
    
    const a_value = Math.sin(latitude_difference / 2) * Math.sin(latitude_difference / 2) +
        Math.cos(latitude1 * Math.PI / 180) * Math.cos(latitude2 * Math.PI / 180) * 
        Math.sin(longitude_difference / 2) * Math.sin(longitude_difference / 2);
    
    const c_value = 2 * Math.atan2(Math.sqrt(a_value), Math.sqrt(1 - a_value));
    const distance_in_km = earth_radius_km * c_value;
    
    return distance_in_km;
}

function format_distance_for_display(distance_in_kilometers) {
    if (distance_in_kilometers < 1) {
        const distance_in_meters = distance_in_kilometers * 1000;
        return distance_in_meters.toFixed(0) + 'm';
    } else {
        return distance_in_kilometers.toFixed(1) + 'km';
    }
}

function escape_html_text(text_to_escape) {
    return text_to_escape
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function initialize_sidebar_tab_switching() {
    const all_tab_buttons = document.querySelectorAll('.sidebar-tab');
    
    all_tab_buttons.forEach(function(tab_button) {
        tab_button.addEventListener('click', function() {
            const all_tabs_in_sidebar = document.querySelectorAll('.sidebar-tab');
            all_tabs_in_sidebar.forEach(function(each_tab) {
                each_tab.classList.remove('active');
            });
            
            const all_tab_contents = document.querySelectorAll('.tab-content');
            all_tab_contents.forEach(function(each_content) {
                each_content.classList.remove('active');
            });
            
            tab_button.classList.add('active');
            const tab_identifier = tab_button.dataset.tab;
            const content_element = document.getElementById(`${tab_identifier}-tab`);
            content_element.classList.add('active');
        });
    });
}

initialize_sidebar_tab_switching();

function clear_map_and_state() {
    state.markers.forEach(function(marker_element) {
        map.removeLayer(marker_element);
    });
    
    state.markers = [];
    state.landmarks = [];
    state.selected = null;
}

async function query_overpass_for_landmarks(latitude, longitude, search_radius = CONFIG.SEARCH_RADIUS) {
    const overpassQuery = `[out:json];(` +
        `node["historic"](around:${search_radius},${latitude},${longitude});` +
        `way["historic"](around:${search_radius},${latitude},${longitude});` +
        `relation["historic"](around:${search_radius},${latitude},${longitude});` +
        `node["tourism"="attraction"](around:${search_radius},${latitude},${longitude});` +
        `way["tourism"="attraction"](around:${search_radius},${latitude},${longitude});` +
        `relation["tourism"="attraction"](around:${search_radius},${latitude},${longitude});` +
        `node["amenity"="place_of_worship"](around:${search_radius},${latitude},${longitude});` +
        `way["amenity"="place_of_worship"](around:${search_radius},${latitude},${longitude});` +
        `relation["amenity"="place_of_worship"](around:${search_radius},${latitude},${longitude});` +
        `);out tags center;`;
    
    try {
        const request_url = CONFIG.OVERPASS_URL + '?data=' + encodeURIComponent(overpass_query);
        const response = await fetch(request_url);
        const responseData = await response.json();
        const landmarkElements = responseData.elements || [];
        return landmarkElements;
    } catch (error) {
        console.error('Overpass API error:', error);
        showToast('Failed to query Overpass API', 'error');
        return [];
    }
}

function build_landmarks_from_elements(overpass_elements, reference_latitude, reference_longitude) {
    const processed_landmarks = [];
    
    overpass_elements.forEach(function(element) {
        const elementTags = element.tags || {};
        const landmarkName = elementTags.name || '(Unnamed)';
        
        let landmarkLatitude = element.lat;
        let landmarkLongitude = element.lon;
        
        if ((!landmarkLatitude || !landmarkLongitude) && element.center) {
            landmarkLatitude = element.center.lat;
            landmarkLongitude = element.center.lon;
        }
        
        if (!landmarkLatitude || !landmarkLongitude) {
            return;
        }
        
        const distanceFromReference = calculateDistance(
            referenceLatitude, 
            referenceLongitude, 
            landmarkLatitude, 
            landmarkLongitude
        );
        
        const landmarkObject = {
            id: `${element.type}-${element.id}`,
            name: landmarkName,
            lat: landmarkLatitude,
            lon: landmarkLongitude,
            distance: distanceFromReference,
            osmType: element.type,
            osmId: element.id,
            tags: elementTags,
            wikidata: elementTags.wikidata || null,
            wikipedia: elementTags.wikipedia || null,
        };
        
        processedLandmarks.push(landmarkObject);
    });
    
    processedLandmarks.sort(function(landmarkA, landmarkB) {
        return landmarkA.distance - landmarkB.distance;
    });
    
    return processedLandmarks;
}

async function fetchHistoricalTextForLandmark(landmark) {
    if (state.cachedTexts[landmark.id]) {
        return state.cachedTexts[landmark.id];
    }

    try {
        const requestPayload = {
            landmark_name: landmark.name,
            wikidata_id: landmark.wikidata,
            wikipedia_url: landmark.wikipedia,
        };
        
        const response = await fetch(`${CONFIG.API_BASE_URL}/api/retrieve-text`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestPayload),
        });

        if (!response.ok) {
            throw new Error(`HTTP Error ${response.status}`);
        }
        
        const responseData = await response.json();
        
        state.cachedTexts[landmark.id] = responseData;
        return responseData;
    } catch (error) {
        console.error('Error fetching historical text:', error);
        return { 
            status: 'error', 
            text: null, 
            error: error.message 
        };
    }
}

async function generateLLMAnswerForLandmark(landmark, userQuestion, yearFilter = null) {
    const cacheKey = `${landmark.id}-${userQuestion}-${yearFilter || 'all'}`;
    
    if (state.cachedAnswers[cacheKey]) {
        return state.cachedAnswers[cacheKey];
    }

    try {
        const requestPayload = {
            landmark_name: landmark.name,
            landmark_metadata: landmark.tags,
            historical_text: state.cachedTexts[landmark.id]?.text,
            question: userQuestion,
            year: yearFilter,
        };
        
        const response = await fetch(`${CONFIG.API_BASE_URL}/api/generate-answer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestPayload),
        });

        if (!response.ok) {
            throw new Error(`HTTP Error ${response.status}`);
        }
        
        const responseData = await response.json();
        
        state.cachedAnswers[cacheKey] = responseData;
        return responseData;
    } catch (error) {
        console.error('Error generating LLM answer:', error);
        return { 
            status: 'error', 
            answer: null, 
            error: error.message 
        };
    }
}

function renderLandmarkList() {
    const listContainer = document.getElementById('resultsList');
    
    if (state.landmarks.length === 0) {
        listContainer.innerHTML = `<div class="empty-state"><div class="empty-state-icon"></div><p>No landmarks found. Try clicking elsewhere on the map.</p></div>`;
        return;
    }

    const landmarkItemsHTML = state.landmarks.map(function(landmark) {
        const isSelected = state.selected?.id === landmark.id ? 'selected' : '';
        const landmarkType = landmark.tags.historic || landmark.tags.tourism || landmark.tags.amenity || 'landmark';
        const displayDistance = formatDistanceForDisplay(landmark.distance);
        const escapedName = escapeHtmlText(landmark.name);
        
        return `
            <div class="landmark-item ${isSelected}" onclick="selectLandmark('${landmark.id}')">
                <div class="landmark-item-name">${escapedName}</div>
                <div class="landmark-item-type">${landmark.osmType} • ${landmarkType}</div>
                <div class="landmark-item-dist">↔ ${displayDistance}</div>
            </div>
        `;
    }).join('');
    
    listContainer.innerHTML = landmarkItemsHTML;
}

async function renderLandmarkDetailsPanel(landmark) {
    const detailsPanelElement = document.getElementById('detailsPanel');
    const escapedLandmarkName = escapeHtmlText(landmark.name);
    const formattedCoordinates = `${landmark.lat.toFixed(4)}, ${landmark.lon.toFixed(4)}`;
    const formattedDistance = formatDistanceForDisplay(landmark.distance);

    const tagsHTML = Object.entries(landmark.tags).map(function([tagKey, tagValue]) {
        return `<div class="tag"><span class="tag-key">${escapeHtmlText(tagKey)}:</span><span>${escapeHtmlText(tagValue)}</span></div>`;
    }).join('');

    detailsPanelElement.innerHTML = `
        <div class="panel-section">
            <h3>Location & Info</h3>
            <div class="metadata-row"><span class="metadata-row-label">Name:</span><span>${escapedLandmarkName}</span></div>
            <div class="metadata-row"><span class="metadata-row-label">Type:</span><span>${landmark.osmType}</span></div>
            <div class="metadata-row"><span class="metadata-row-label">Coordinates:</span><span>${formattedCoordinates}</span></div>
            <div class="metadata-row"><span class="metadata-row-label">Distance:</span><span>${formattedDistance}</span></div>
            <div class="metadata-row"><span class="metadata-row-label">OSM ID:</span><span>${landmark.osmId}</span></div>
        </div>

        <div class="panel-section">
            <h3>Tags</h3>
            <div class="tags-grid">
                ${tagsHTML}
            </div>
        </div>

        <div class="panel-section">
            <h3>History</h3>
            <div id="contextStatus" class="context-status loading"><span class="loading-spinner"></span> Loading...</div>
            <div id="contextText" class="context-text" style="display:none;"></div>
        </div>
    `;

    const historicalTextData = await fetchHistoricalTextForLandmark(landmark);
    const statusElement = document.getElementById('contextStatus');
    const contextElement = document.getElementById('contextText');

    if (historicalTextData.status === 'success' && historicalTextData.text) {
        statusElement.innerHTML = `<span class="status-badge ok">Got it</span>`;
        contextElement.textContent = historicalTextData.text;
        contextElement.style.display = 'block';
    } else if (historicalTextData.status === 'no_data') {
        statusElement.innerHTML = `<span class="status-badge warning">No text available</span>`;
    } else {
        const errorMessage = historicalTextData.error || 'unknown error';
        statusElement.innerHTML = `<span class="status-badge error">Error: ${errorMessage}</span>`;
    }
}

async function renderRAGPanel(landmark) {
    const ragPanelElement = document.getElementById('ragPanel');

    ragPanelElement.innerHTML = `
        <div class="panel-section">
            <h3>Ask Something</h3>
            <input type="text" class="question-input" id="questionInput" placeholder="e.g., What happened here in 1850?" />
            <input type="number" class="year-input" id="yearInput" placeholder="Year (optional)" min="1000" max="2100" />
            <button onclick="generateAndDisplayAnswer()" style="width: 100%;">Generate</button>
        </div>

        <div class="panel-section">
            <h3>Prompt Context</h3>
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

    const historicalTextData = await fetchHistoricalTextForLandmark(landmark);
    const constructedPrompt = buildSystemPromptForLandmark(landmark, historicalTextData);
    document.getElementById('promptTemplate').textContent = constructedPrompt;
}

function buildSystemPromptForLandmark(landmark, historicalText) {
    const systemInstruction = `You are a historical assistant. Answer ONLY using the provided context. If you don't know, say so. Don't make stuff up.`;
    
    const metadataLines = Object.entries(landmark.tags).map(function([tagKey, tagValue]) {
        return `${tagKey}: ${tagValue}`;
    }).join('\n');

    const availableContext = historicalText.status === 'success' && historicalText.text 
        ? historicalText.text 
        : '[No historical text available]';

    const formattedCoordinates = `${landmark.lat.toFixed(4)}, ${landmark.lon.toFixed(4)}`;

    const completePrompt = `SYSTEM INSTRUCTION:
${systemInstruction}

LANDMARK INFORMATION:
Name: ${landmark.name}
Type: ${landmark.osmType}
Coordinates: ${formattedCoordinates}

LANDMARK METADATA:
${metadataLines}

HISTORICAL CONTEXT:
${availableContext}

Please answer based ONLY on the above information.`;
    
    return completePrompt;
}

async function generateAndDisplayAnswer() {
    if (!state.selected) {
        return;
    }

    const userQuestionElement = document.getElementById('questionInput');
    const yearFilterElement = document.getElementById('yearInput');
    
    const userQuestion = userQuestionElement?.value || '';
    const selectedYear = yearFilterElement?.value || null;

    if (!userQuestion.trim()) {
        showToast('Please enter a question', 'error');
        return;
    }

    const generateButton = event.target;
    generateButton.disabled = true;
    generateButton.textContent = 'Thinking...';

    try {
        const parsedYear = selectedYear ? parseInt(selectedYear) : null;
        const llmResponse = await generateLLMAnswerForLandmark(state.selected, userQuestion, parsedYear);
        const answerSectionElement = document.getElementById('answerSection');

        if (llmResponse.status === 'success' && llmResponse.answer) {
            document.getElementById('answerText').textContent = llmResponse.answer;
            document.getElementById('answerSource').innerHTML = `<strong>Source:</strong> Local LLM (Ollama)`;
            answerSectionElement.style.display = 'block';
            showToast('Answer generated successfully!', 'success');
        } else {
            const errorMessage = llmResponse.error || 'unknown error';
            document.getElementById('answerText').textContent = `Error: ${errorMessage}`;
            answerSectionElement.style.display = 'block';
            showToast('Failed to generate answer', 'error');
        }
    } finally {
        generateButton.disabled = false;
        generateButton.textContent = 'Generate';
    }
}

async function selectLandmark(landmarkId) {
    state.selected = state.landmarks.find(function(eachLandmark) {
        return eachLandmark.id === landmarkId;
    });
    
    if (!state.selected) {
        return;
    }

    renderLandmarkList();
    
    map.flyTo([state.selected.lat, state.selected.lon], 16);
    
    await renderLandmarkDetailsPanel(state.selected);
    await renderRAGPanel(state.selected);

    const allTabButtons = document.querySelectorAll('.sidebar-tab');
    allTabButtons.forEach(function(tabButton) {
        tabButton.classList.remove('active');
    });
    
    const allTabContents = document.querySelectorAll('.tab-content');
    allTabContents.forEach(function(tabContent) {
        tabContent.classList.remove('active');
    });
    
    document.querySelector('[data-tab="details"]').classList.add('active');
    document.getElementById('details-tab').classList.add('active');
}

async function searchForPlace(placeName) {
    if (!placeName.trim()) {
        return;
    }

    try {
        const searchUrl = `${CONFIG.NOMINATIM_URL}?q=${encodeURIComponent(placeName)}&format=json&limit=1`;
        const searchResponse = await fetch(searchUrl);
        const searchResults = await searchResponse.json();

        if (searchResults.length === 0) {
            showToast(`Place "${placeName}" not found`, 'error');
            return;
        }

        const firstResult = searchResults[0];
        const foundLatitude = parseFloat(firstResult.lat);
        const foundLongitude = parseFloat(firstResult.lon);

        map.flyTo([foundLatitude, foundLongitude], 14);
        queryLandmarksAtLocation(foundLatitude, foundLongitude);
        showToast(`Found: ${firstResult.display_name}`, 'success');
    } catch (error) {
        console.error('Place search error:', error);
        showToast('Search failed - please try again', 'error');
    }
}

async function queryLandmarksAtLocation(latitude, longitude) {
    clearMapAndState();
    
    document.getElementById('resultsList').innerHTML = `<div class="empty-state"><div class="loading-spinner"></div><p>Querying for landmarks...</p></div>`;

    const overpassElements = await queryOverpassForLandmarks(latitude, longitude);
    state.landmarks = buildLandmarksFromElements(overpassElements, latitude, longitude);

    if (state.landmarks.length === 0) {
        document.getElementById('resultsList').innerHTML = `<div class="empty-state"><div class="empty-state-icon"></div><p>No landmarks found in this area.</p></div>`;
        return;
    }

    state.landmarks.forEach(function(landmark) {
        const markerElement = L.marker([landmark.lat, landmark.lon]).addTo(map);
        
        markerElement.on('click', function() {
            selectLandmark(landmark.id);
        });
        
        state.markers.push(markerElement);
    });

    renderLandmarkList();
    const landmarkCount = state.landmarks.length;
    showToast(`Found ${landmarkCount} landmarks in this area`, 'success');
}



function locateUserAndFindLandmarks() {
    if (!navigator.geolocation) {
        showToast('Geolocation not supported by your browser', 'error');
        return;
    }

    navigator.geolocation.getCurrentPosition(
        function(position) {
            const userLatitude = position.coords.latitude;
            const userLongitude = position.coords.longitude;
            
            map.flyTo([userLatitude, userLongitude], 14);
            queryLandmarksAtLocation(userLatitude, userLongitude);
            showToast('Found your location successfully', 'success');
        },
        function(error) {
            console.error('Geolocation error:', error);
            showToast('Unable to access your location - please check permissions', 'error');
        }
    );
}

function resetMapToInitialState() {
    clearMapAndState();
    
    document.getElementById('resultsList').innerHTML = `<div class="empty-state"><div class="empty-state-icon"></div><p>Click the map to find landmarks or use the search.</p></div>`;
    document.getElementById('detailsPanel').innerHTML = `<div class="empty-state"><div class="empty-state-icon"></div><p>Select a landmark to view details.</p></div>`;
    document.getElementById('ragPanel').innerHTML = `<div class="empty-state"><div class="empty-state-icon"></div><p>Select a landmark to ask questions.</p></div>`;
    
    map.flyTo([CONFIG.DEFAULT_LAT, CONFIG.DEFAULT_LON], CONFIG.DEFAULT_ZOOM);
    showToast('Map reset to initial state', 'success');
}

document.getElementById('searchInput').addEventListener('keypress', function(event) {
    if (event.key === 'Enter') {
        const searchValue = event.target.value;
        searchForPlace(searchValue);
        event.target.value = '';
    }
});

document.getElementById('gpsBtn').addEventListener('click', function() {
    locateUserAndFindLandmarks();
});

document.getElementById('resetBtn').addEventListener('click', function() {
    resetMapToInitialState();
});

map.on('click', function(mapClickEvent) {
    const clickedLatitude = mapClickEvent.latlng.lat;
    const clickedLongitude = mapClickEvent.latlng.lng;
    queryLandmarksAtLocation(clickedLatitude, clickedLongitude);
});

console.log('Interactive History Platform loaded successfully. Click on the map or search for a place to begin.');
