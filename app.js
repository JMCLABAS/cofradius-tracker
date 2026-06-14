// app.js

// 1. Configuración y Credenciales de Supabase
const SUPABASE_URL = 'https://khzsxoazhxapuoxwuvns.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_A6yYq2Pcee64gdx_w3t-cQ_yjISV7kJ';

// Inicializar cliente Supabase
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Inicialización del Mapa Leaflet
// Centro por defecto en la Catedral de Sevilla (mientras carga o busca datos)
const map = L.map('map', { zoomControl: false }).setView([37.3858, -5.9931], 16);

// Añadimos el control de zoom en otra esquina para que no pise el panel
L.control.zoom({ position: 'topleft' }).addTo(map);

// Capa base de OpenStreetMap estándar (garantiza máxima visibilidad de calles)
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19
}).addTo(map);

// 3. Variables de Estado
let currentMarker = null;
let pathPolyline = null;
let positions = []; // Array de coordenadas [lat, lng] de Supabase
let lastUpdateTime = null; // Guardará la fecha UTC de la última posición
let counterInterval = null;

// -- Variables Planificador --
let isPlannerMode = false;

// Base de datos de Hermandades
const hermandadesDB = {
    "original": {
        nombre: "Mi Hermandad",
        archivoGeojson: "ruta_planificador.geojson",
        pasos: [
            { nombre: "Cristo", iconoUrl: "paso.png", offsetMinutos: 0 },
            { nombre: "Palio", iconoUrl: "palio.png", offsetMinutos: 30 }
        ],
        itinerario: [
            { nombre: "Salida", hora: new Date(2026, 2, 29, 17, 0) },
            { nombre: "Punto Medio", hora: new Date(2026, 2, 29, 19, 0) },
            { nombre: "Zona Norte", hora: new Date(2026, 2, 29, 21, 0) },
            { nombre: "Entrada", hora: new Date(2026, 2, 29, 23, 0) }
        ]
    },
    "pepe_gonzalez": {
        nombre: "CEIP Pepe González",
        archivoGeojson: "ruta_pepe_gonzalez.geojson", 
        pasos: [
            { nombre: "Paso Único", iconoUrl: "paso.png", offsetMinutos: 0 }
        ],
        itinerario: [
            { nombre: "Salida", hora: new Date(2026, 2, 29, 17, 30) },
            { nombre: "Entrada", hora: new Date(2026, 2, 30, 0, 0) } // 00:00 del día siguiente
        ]
    }
};

// Icono personalizado para la chincheta real (Marcador destacado)
const customIcon = L.icon({
    iconUrl: 'chincheta.png', 
    iconSize: [60, 48], 
    iconAnchor: [30, 48], 
    popupAnchor: [0, -48]
});

// Icono de Iglesia para el planificador (Iglesia Fija)
const churchIcon = L.divIcon({
    html: '<div style="font-size: 40px; color: #5D4037; text-shadow: 2px 2px 0px white, -2px -2px 0px white, 2px -2px 0px white, -2px 2px 0px white; text-align: center; line-height: 40px;">⛪</div>',
    className: 'custom-church-icon',
    iconSize: [40, 40],
    iconAnchor: [20, 20]
});

// Función para generar dinámicamente un icono
function createPasoIcon(url) {
    return L.icon({
        iconUrl: url, 
        iconSize: [70, 70], 
        iconAnchor: [35, 65], 
        popupAnchor: [0, -65]
    });
}

// 4. Cargar Rutas Planificadas (GeoJSON) Dinámicas
async function loadAllPlannedRoutes() {
    const fetchPromises = [];
    for (const id in hermandadesDB) {
        const h = hermandadesDB[id];
        const p = fetch(h.archivoGeojson).then(res => {
            if (!res.ok) throw new Error(`Error HTTP: ${res.status}`);
            return res.json();
        }).then(geojsonData => {
            const feature = geojsonData.features.find(f => f.geometry.type === 'LineString');
            if (feature) {
                h.puntosRutaGeojson = feature.geometry.coordinates.map(coord => [coord[1], coord[0]]);
            } else {
                h.puntosRutaGeojson = [];
            }
            h.plannedRouteLayer = L.geoJSON(geojsonData, {
                filter: function(feature) {
                    return feature.geometry.type !== 'Point';
                },
                style: {
                    color: '#673ab7',
                    weight: 5,
                    opacity: 0.6
                }
            });
            h.activePasoMarkers = [];
            h.fixedChurchMarker = null;
            console.log(`Ruta ${h.archivoGeojson} cargada correctamente.`);
        }).catch(error => {
            console.warn(`No se pudo cargar ${h.archivoGeojson}:`, error.message);
            h.puntosRutaGeojson = [];
        });
        fetchPromises.push(p);
    }
    await Promise.all(fetchPromises);
}

// 5. Cargar Datos Históricos (Estela inicial)
async function loadInitialData() {
    try {
        const { data, error } = await supabaseClient
            .from('posicion_real')
            .select('*')
            .order('created_at', { ascending: true });

        if (error) throw error;

        if (data && data.length > 0) {
            // Extraer solo las coordenadas para la polyline
            positions = data.map(row => [row.latitud, row.longitud]);
            
            // Dibujar la estela (rastro)
            pathPolyline = L.polyline(positions, {
                color: '#4a154b', // Morado Nazareno
                weight: 5,
                opacity: 0.8,
                lineCap: 'round',
                lineJoin: 'round'
            }).addTo(map);

            // Colocar marcador en la última posición conocida
            const lastRow = data[data.length - 1];
            updateMarkerAndMap(lastRow.latitud, lastRow.longitud, false);
            
            // Actualizar fecha usando el Date nativo (parsea automáticamente el timestamptz ISO de Supabase)
            lastUpdateTime = new Date(lastRow.created_at);
            startCounter();
        } else {
            document.getElementById('time-counter').textContent = "Esperando primer dato...";
        }
    } catch (error) {
        console.error('Error cargando datos iniciales de Supabase:', error.message);
        document.getElementById('time-counter').textContent = "Error de conexión";
    }
}

// 6. Tiempo Real (WebSockets con Supabase)
function subscribeToRealTime() {
    supabaseClient
        .channel('public:posicion_real')
        .on(
            'postgres_changes', 
            { event: 'INSERT', schema: 'public', table: 'posicion_real' }, 
            payload => {
                const newRow = payload.new;
                console.log('Nueva posición recibida en vivo:', newRow);
                
                const newCoord = [newRow.latitud, newRow.longitud];
                
                // Actualizar array
                positions.push(newCoord);
                
                // Actualizar Polyline
                if (pathPolyline) {
                    pathPolyline.setLatLngs(positions);
                } else {
                    pathPolyline = L.polyline(positions, {
                        color: '#4a154b', // Morado Nazareno
                        weight: 5,
                        opacity: 0.8,
                        lineCap: 'round',
                        lineJoin: 'round'
                    }).addTo(map);
                }

                // Mover marcador y centrar mapa
                updateMarkerAndMap(newRow.latitud, newRow.longitud, true);

                // Reiniciar contador de tiempo (usando la hora del evento)
                lastUpdateTime = new Date(newRow.created_at);
                updateCounterDisplay(); 
            }
        )
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log('📡 Suscripción a WebSocket activada correctamente.');
            } else if (status === 'CHANNEL_ERROR') {
                console.error('❌ Error en el canal de WebSocket.');
            }
        });
}

// Función auxiliar para mover el marcador y ajustar la vista
function updateMarkerAndMap(lat, lng, smoothPan = false) {
    const latLng = [lat, lng];
    
    if (currentMarker) {
        currentMarker.setLatLng(latLng);
    } else {
        currentMarker = L.marker(latLng, { icon: customIcon }).addTo(map);
    }
    
    // Centramos el mapa en la nueva ubicación
    if (smoothPan) {
        // Pan suave para actualizaciones en vivo
        map.panTo(latLng, { animate: true, duration: 1.0 });
    } else {
        // Carga inicial directa
        map.setView(latLng, 17);
    }
}

// 7. Lógica del Contador de "Última Actualización"
function startCounter() {
    if (counterInterval) clearInterval(counterInterval);
    updateCounterDisplay(); // Actualización inmediata
    counterInterval = setInterval(updateCounterDisplay, 1000); // Actualiza cada segundo
}

function updateCounterDisplay() {
    const counterElement = document.getElementById('time-counter');
    
    if (!lastUpdateTime) {
        counterElement.textContent = "Calculando...";
        return;
    }

    // Comparamos el momento actual (hora local del navegador) con la fecha UTC parseada
    const now = new Date();
    const diffMs = now - lastUpdateTime;
    const diffSecs = Math.max(0, Math.floor(diffMs / 1000)); // Evitamos valores negativos por desajustes de reloj
    
    if (diffSecs < 60) {
        counterElement.textContent = `hace ${diffSecs} segundo${diffSecs !== 1 ? 's' : ''}`;
    } else {
        const diffMins = Math.floor(diffSecs / 60);
        counterElement.textContent = `hace ${diffMins} minuto${diffMins !== 1 ? 's' : ''}`;
    }
}

// 8. LÓGICA DEL PLANIFICADOR
function calcularPosicionTeorica(horaActual, itinerario, puntosRuta) {
    if (!puntosRuta || puntosRuta.length === 0 || itinerario.length === 0) return [0,0];
    
    const horaSalida = itinerario[0].hora;
    const horaEntrada = itinerario[itinerario.length - 1].hora;

    if (horaActual <= horaSalida) return puntosRuta[0];
    if (horaActual >= horaEntrada) return puntosRuta[puntosRuta.length - 1];

    let tramoActual = 0;
    for (let i = 0; i < itinerario.length - 1; i++) {
        if (horaActual >= itinerario[i].hora && horaActual < itinerario[i + 1].hora) {
            tramoActual = i;
            break;
        }
    }

    const inicioTramo = itinerario[tramoActual].hora;
    const finTramo = itinerario[tramoActual + 1].hora;
    const duracionTramo = (finTramo - inicioTramo);
    const transcurrido = (horaActual - inicioTramo);
    const progresoEnTramo = Math.max(0, Math.min(1, transcurrido / duracionTramo));

    const totalPuntos = puntosRuta.length;
    const numTramos = itinerario.length - 1;
    const puntosPorTramo = Math.floor(totalPuntos / numTramos);
    
    const indiceInicioRuta = tramoActual * puntosPorTramo;
    let indiceFinRuta = (tramoActual + 1) * puntosPorTramo;
    if (tramoActual === numTramos - 1) indiceFinRuta = totalPuntos - 1;

    const posicionEnRuta = indiceInicioRuta + (progresoEnTramo * (indiceFinRuta - indiceInicioRuta));
    const idxA = Math.floor(posicionEnRuta);
    const idxB = Math.min(idxA + 1, totalPuntos - 1);
    const microProgreso = posicionEnRuta - idxA;

    const pA = puntosRuta[idxA];
    const pB = puntosRuta[idxB];

    return [
        pA[0] + (pB[0] - pA[0]) * microProgreso,
        pA[1] + (pB[1] - pA[1]) * microProgreso
    ];
}

function setupViews() {
    const btnGoPlanner = document.getElementById('btn-go-planner');
    const btnGoLive = document.getElementById('btn-go-live');
    const liveContainer = document.getElementById('live-view-container');
    const plannerContainer = document.getElementById('planner-view-container');

    // MODO EN VIVO
    btnGoLive.addEventListener('click', () => {
        isPlannerMode = false;
        liveContainer.classList.remove('hidden');
        plannerContainer.classList.add('hidden');
        
        document.querySelector('.leaflet-tile-pane').style.filter = '';
        
        if (currentMarker) currentMarker.setOpacity(1);
        if (pathPolyline) pathPolyline.setStyle({opacity: 0.8});
        
        for (const id in hermandadesDB) {
            const h = hermandadesDB[id];
            if (h.activePasoMarkers) h.activePasoMarkers.forEach(m => m.marker.setOpacity(0));
            if (h.fixedChurchMarker) h.fixedChurchMarker.setOpacity(0);
            
            if (h.plannedRouteLayer && map.hasLayer(h.plannedRouteLayer)) {
                map.removeLayer(h.plannedRouteLayer);
            }
        }
        
        if (currentMarker) map.panTo(currentMarker.getLatLng(), {animate: true});
    });

    // MODO PLANIFICADOR
    btnGoPlanner.addEventListener('click', () => {
        isPlannerMode = true;
        plannerContainer.classList.remove('hidden');
        liveContainer.classList.add('hidden');
        
        document.querySelector('.leaflet-tile-pane').style.filter = 'none';
        
        if (currentMarker) currentMarker.setOpacity(0.0);
        if (pathPolyline) pathPolyline.setStyle({opacity: 0.0});
        
        const bounds = L.latLngBounds();
        for (const id in hermandadesDB) {
            const h = hermandadesDB[id];
            if (h.plannedRouteLayer && !map.hasLayer(h.plannedRouteLayer)) {
                h.plannedRouteLayer.addTo(map);
            }
            if (h.puntosRutaGeojson && h.puntosRutaGeojson.length > 0) {
                h.puntosRutaGeojson.forEach(pt => bounds.extend(pt));
            }
        }
        
        setupPlannerMarkers();
        updatePlannerFromSlider();
        
        if (bounds.isValid()) {
            map.fitBounds(bounds, { padding: [50, 50] });
        }
    });
}

function setupPlannerMarkers() {
    for (const id in hermandadesDB) {
        const h = hermandadesDB[id];
        
        // Iglesia Fija
        if (!h.fixedChurchMarker && h.puntosRutaGeojson && h.puntosRutaGeojson.length > 0) {
            h.fixedChurchMarker = L.marker(h.puntosRutaGeojson[0], { icon: churchIcon }).addTo(map);
        }
        if (h.fixedChurchMarker) h.fixedChurchMarker.setOpacity(1);
        
        // Limpiar marcadores antiguos
        if (h.activePasoMarkers) {
            h.activePasoMarkers.forEach(m => map.removeLayer(m.marker));
        }
        h.activePasoMarkers = [];
        
        // Generar marcadores para los pasos
        if (h.puntosRutaGeojson && h.puntosRutaGeojson.length > 0) {
            h.pasos.forEach((paso, index) => {
                const marker = L.marker(h.puntosRutaGeojson[0], { 
                    icon: createPasoIcon(paso.iconoUrl), 
                    zIndexOffset: 1000 - index 
                }).addTo(map);
                h.activePasoMarkers.push({
                    marker: marker,
                    offset: paso.offsetMinutos
                });
            });
        }
    }
}

function setupSlider() {
    const slider = document.getElementById('planner-slider');
    
    let minDate = new Date('2999-01-01').getTime();
    let maxDate = new Date('1970-01-01').getTime();
    
    for (const id in hermandadesDB) {
        const h = hermandadesDB[id];
        if (h.itinerario.length === 0) continue;
        
        const hSalida = h.itinerario[0].hora.getTime();
        const hEntrada = h.itinerario[h.itinerario.length - 1].hora.getTime();
        
        let maxOffsetMs = 0;
        h.pasos.forEach(p => {
            if ((p.offsetMinutos * 60000) > maxOffsetMs) maxOffsetMs = (p.offsetMinutos * 60000);
        });
        
        if (hSalida < minDate) minDate = hSalida;
        if ((hEntrada + maxOffsetMs) > maxDate) maxDate = hEntrada + maxOffsetMs;
    }
    
    if (minDate > maxDate) return;
    window.globalSliderMinDate = minDate;
    
    const totalMinutos = (maxDate - minDate) / 60000;
    
    slider.max = totalMinutos;
    slider.value = 0;
    
    if (!slider.hasAttribute('data-initialized')) {
        slider.addEventListener('input', updatePlannerFromSlider);
        slider.setAttribute('data-initialized', 'true');
    }
}

function updatePlannerFromSlider() {
    const slider = document.getElementById('planner-slider');
    const display = document.getElementById('planner-time-display');
    
    if (!window.globalSliderMinDate) return;
    
    const minutos = parseInt(slider.value, 10);
    const horaSimulada = new Date(window.globalSliderMinDate + (minutos * 60000));
    
    const hh = String(horaSimulada.getHours()).padStart(2, '0');
    const mm = String(horaSimulada.getMinutes()).padStart(2, '0');
    display.textContent = `${hh}:${mm}`;

    if (isPlannerMode) {
        for (const id in hermandadesDB) {
            const h = hermandadesDB[id];
            if (h.puntosRutaGeojson && h.puntosRutaGeojson.length > 0 && h.itinerario.length > 0) {
                if (h.activePasoMarkers) {
                    h.activePasoMarkers.forEach(pasoData => {
                        const horaSimuladaPaso = new Date(horaSimulada.getTime() - (pasoData.offset * 60000));
                        const posicion = calcularPosicionTeorica(horaSimuladaPaso, h.itinerario, h.puntosRutaGeojson);
                        pasoData.marker.setLatLng(posicion);
                    });
                }
            }
        }
    }
}

// 9. Inicialización de la Aplicación
document.addEventListener('DOMContentLoaded', async () => {
    setupViews();
    setupSlider();
    
    await loadAllPlannedRoutes();
    
    if (isPlannerMode) updatePlannerFromSlider();
    
    loadInitialData();      // SELECT a Supabase para cargar historial
    subscribeToRealTime();  // Abrir WebSocket para nuevos INSERTs
});
