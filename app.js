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
let puntosRutaGeojson = [];
let isPlannerMode = false;
let plannerMarker = null;
let fixedChurchMarker = null;
let plannedRouteLayer = null;

// Definimos el itinerario oficial (Mes 2 en JS Date = Marzo)
const itinerarioOficial = [
    { nombre: "Salida", hora: new Date(2026, 2, 29, 17, 0) },
    { nombre: "Punto Medio", hora: new Date(2026, 2, 29, 19, 0) },
    { nombre: "Zona Norte", hora: new Date(2026, 2, 29, 21, 0) },
    { nombre: "Entrada", hora: new Date(2026, 2, 29, 23, 0) }
];

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

// Icono del Paso (Imagen 3D que se mueve)
const pasoIcon = L.icon({
    iconUrl: 'paso.png', 
    iconSize: [70, 70], 
    iconAnchor: [35, 65], // Anclado por la base
    popupAnchor: [0, -65]
});

// 4. Cargar Ruta Planificada (GeoJSON)
async function loadPlannedRoute() {
    try {
        const response = await fetch('ruta_planificador.geojson');
        if (!response.ok) {
            throw new Error(`Error HTTP: ${response.status}`);
        }
        const geojsonData = await response.json();
        
        // Guardar las coordenadas del GeoJSON para la matemática del Planificador
        const feature = geojsonData.features.find(f => f.geometry.type === 'LineString');
        if (feature) {
            // GeoJSON almacena [lng, lat], Leaflet usa [lat, lng]
            puntosRutaGeojson = feature.geometry.coordinates.map(coord => [coord[1], coord[0]]);
        }
        
        plannedRouteLayer = L.geoJSON(geojsonData, {
            style: {
                color: '#673ab7', // deepPurple como en Flutter
                weight: 5,
                opacity: 0.6
            }
        });
        
        // Por defecto arranca en modo en vivo, así que NO lo añadimos al mapa todavía.
        // Se añadirá cuando pulsemos la pestaña de Planificador.
        
        console.log('Ruta planificada cargada correctamente.');
    } catch (error) {
        console.warn('No se pudo cargar ruta_planificador.geojson:', error.message);
    }
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
function calcularPosicionTeorica(horaActual) {
    if (puntosRutaGeojson.length === 0) return [0,0]; // Fallback
    
    const horaSalida = itinerarioOficial[0].hora;
    const horaEntrada = itinerarioOficial[itinerarioOficial.length - 1].hora;

    if (horaActual <= horaSalida) return puntosRutaGeojson[0];
    if (horaActual >= horaEntrada) return puntosRutaGeojson[puntosRutaGeojson.length - 1];

    // 1. Buscamos en qué tramo del horario estamos
    let tramoActual = 0;
    for (let i = 0; i < itinerarioOficial.length - 1; i++) {
        if (horaActual >= itinerarioOficial[i].hora && horaActual < itinerarioOficial[i + 1].hora) {
            tramoActual = i;
            break;
        }
    }

    // 2. Calculamos el progreso dentro de ESE tramo (de 0.0 a 1.0)
    const inicioTramo = itinerarioOficial[tramoActual].hora;
    const finTramo = itinerarioOficial[tramoActual + 1].hora;
    
    const duracionTramo = (finTramo - inicioTramo);
    const transcurrido = (horaActual - inicioTramo);
    const progresoEnTramo = Math.max(0, Math.min(1, transcurrido / duracionTramo));

    // 3. Puntos de ruta por tramo
    const totalPuntos = puntosRutaGeojson.length;
    const numTramos = itinerarioOficial.length - 1;
    const puntosPorTramo = Math.floor(totalPuntos / numTramos);
    
    const indiceInicioRuta = tramoActual * puntosPorTramo;
    let indiceFinRuta = (tramoActual + 1) * puntosPorTramo;
    if (tramoActual === numTramos - 1) indiceFinRuta = totalPuntos - 1;

    // 4. Interpolamos entre los puntos
    const posicionEnRuta = indiceInicioRuta + (progresoEnTramo * (indiceFinRuta - indiceInicioRuta));
    const idxA = Math.floor(posicionEnRuta);
    const idxB = Math.min(idxA + 1, totalPuntos - 1);
    const microProgreso = posicionEnRuta - idxA;

    const pA = puntosRutaGeojson[idxA];
    const pB = puntosRutaGeojson[idxB];

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
        
        // Restaurar filtro blanco y negro para modo en vivo
        document.querySelector('.leaflet-tile-pane').style.filter = '';
        
        if (currentMarker) currentMarker.setOpacity(1);
        if (pathPolyline) pathPolyline.setStyle({opacity: 0.8});
        if (plannerMarker) plannerMarker.setOpacity(0);
        if (fixedChurchMarker) fixedChurchMarker.setOpacity(0);
        
        // Ocultar ruta planificada
        if (plannedRouteLayer && map.hasLayer(plannedRouteLayer)) {
            map.removeLayer(plannedRouteLayer);
        }
        
        if (currentMarker) map.panTo(currentMarker.getLatLng(), {animate: true});
    });

    // MODO PLANIFICADOR
    btnGoPlanner.addEventListener('click', () => {
        isPlannerMode = true;
        plannerContainer.classList.remove('hidden');
        liveContainer.classList.add('hidden');
        
        // Quitar filtros para que el mapa se vea a todo color en modo planificador
        document.querySelector('.leaflet-tile-pane').style.filter = 'none';
        
        if (currentMarker) currentMarker.setOpacity(0.0); // Ocultar por completo
        if (pathPolyline) pathPolyline.setStyle({opacity: 0.0}); // Ocultar por completo
        
        // Mostrar ruta planificada
        if (plannedRouteLayer && !map.hasLayer(plannedRouteLayer)) {
            plannedRouteLayer.addTo(map);
        }
        
        if (!fixedChurchMarker && puntosRutaGeojson.length > 0) {
            // Iglesia fija en el punto de salida
            fixedChurchMarker = L.marker(puntosRutaGeojson[0], { icon: churchIcon }).addTo(map);
        }
        if (fixedChurchMarker) fixedChurchMarker.setOpacity(1);
        
        if (!plannerMarker) {
            // Marcador móvil usando la foto del paso
            plannerMarker = L.marker(puntosRutaGeojson.length ? puntosRutaGeojson[0] : [0,0], { icon: pasoIcon, zIndexOffset: 1000 }).addTo(map);
        }
        plannerMarker.setOpacity(1);
        
        updatePlannerFromSlider();
        
        // Centrar el mapa en toda la ruta planificada para que se vea el recorrido completo
        if (plannedRouteLayer && map.hasLayer(plannedRouteLayer)) {
            map.fitBounds(plannedRouteLayer.getBounds(), { padding: [50, 50] });
        }
    });
}

function setupSlider() {
    const slider = document.getElementById('planner-slider');
    const horaSalida = itinerarioOficial[0].hora;
    const horaEntrada = itinerarioOficial[itinerarioOficial.length - 1].hora;
    const totalMinutos = (horaEntrada - horaSalida) / 60000;
    
    slider.max = totalMinutos;
    slider.value = 0;
    
    slider.addEventListener('input', updatePlannerFromSlider);
}

function updatePlannerFromSlider() {
    const slider = document.getElementById('planner-slider');
    const display = document.getElementById('planner-time-display');
    const horaSalida = itinerarioOficial[0].hora;
    
    const minutos = parseInt(slider.value, 10);
    const horaSimulada = new Date(horaSalida.getTime() + (minutos * 60000));
    
    const hh = String(horaSimulada.getHours()).padStart(2, '0');
    const mm = String(horaSimulada.getMinutes()).padStart(2, '0');
    display.textContent = `${hh}:${mm}`;

    if (isPlannerMode && puntosRutaGeojson.length > 0) {
        const posicionTeorica = calcularPosicionTeorica(horaSimulada);
        if (plannerMarker) {
            plannerMarker.setLatLng(posicionTeorica);
            // El usuario pidió expresamente no centrar automáticamente mientras se desliza
        }
    }
}

// 9. Inicialización de la Aplicación
document.addEventListener('DOMContentLoaded', async () => {
    setupViews();
    setupSlider();
    
    await loadPlannedRoute(); // Carga de archivo local (GeoJSON). Usamos await para que puntosRutaGeojson esté listo.
    
    // Si entramos directo en planificador, forzar update
    if (isPlannerMode) updatePlannerFromSlider();
    
    loadInitialData();      // SELECT a Supabase para cargar historial
    subscribeToRealTime();  // Abrir WebSocket para nuevos INSERTs
});
