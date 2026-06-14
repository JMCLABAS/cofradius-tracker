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

// Definimos el itinerario oficial (Mes 2 en JS Date = Marzo)
const itinerarioOficial = [
    { nombre: "Salida", hora: new Date(2026, 2, 29, 17, 0) },
    { nombre: "Punto Medio", hora: new Date(2026, 2, 29, 19, 0) },
    { nombre: "Zona Norte", hora: new Date(2026, 2, 29, 21, 0) },
    { nombre: "Entrada", hora: new Date(2026, 2, 29, 23, 0) }
];

// Icono personalizado para la chincheta (Marcador destacado con la imagen del usuario)
const customIcon = L.icon({
    iconUrl: 'chincheta.png', // Debe coincidir con el nombre de la imagen subida al repo
    iconSize: [60, 48], // Ajustado según la proporción de los 3 nazarenos
    iconAnchor: [30, 48], // El ancla en el medio abajo
    popupAnchor: [0, -48]
});

// 4. Cargar Ruta Planificada (GeoJSON)
async function loadPlannedRoute() {
    try {
        const response = await fetch('ruta.geojson');
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
        
        L.geoJSON(geojsonData, {
            style: {
                color: '#6c757d', // Gris oscuro elegante
                weight: 4,
                dashArray: '10, 10', // Línea punteada
                opacity: 0.7
            }
        }).addTo(map);
        console.log('Ruta planificada cargada correctamente.');
    } catch (error) {
        console.warn('No se pudo cargar ruta.geojson o el archivo no existe:', error.message);
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

function setupTabs() {
    const tabLive = document.getElementById('tab-live');
    const tabPlanner = document.getElementById('tab-planner');
    const viewLive = document.getElementById('view-live');
    const viewPlanner = document.getElementById('view-planner');
    const liveBadge = document.getElementById('live-indicator-badge');

    tabLive.addEventListener('click', () => {
        isPlannerMode = false;
        tabLive.classList.add('active');
        tabPlanner.classList.remove('active');
        viewLive.classList.add('active');
        viewLive.classList.remove('hidden');
        viewPlanner.classList.remove('active');
        viewPlanner.classList.add('hidden');
        liveBadge.classList.remove('hidden');
        
        if (currentMarker) currentMarker.setOpacity(1);
        if (pathPolyline) pathPolyline.setStyle({opacity: 0.8});
        if (plannerMarker) plannerMarker.setOpacity(0);
        
        if (currentMarker) map.panTo(currentMarker.getLatLng(), {animate: true});
    });

    tabPlanner.addEventListener('click', () => {
        isPlannerMode = true;
        tabPlanner.classList.add('active');
        tabLive.classList.remove('active');
        viewPlanner.classList.add('active');
        viewPlanner.classList.remove('hidden');
        viewLive.classList.remove('active');
        viewLive.classList.add('hidden');
        liveBadge.classList.add('hidden');
        
        if (currentMarker) currentMarker.setOpacity(0.3); 
        if (pathPolyline) pathPolyline.setStyle({opacity: 0.3});
        
        if (!plannerMarker) {
            // Creamos un segundo marcador para el planificador
            plannerMarker = L.marker(puntosRutaGeojson.length ? puntosRutaGeojson[0] : [0,0], { icon: customIcon }).addTo(map);
        }
        plannerMarker.setOpacity(1);
        
        updatePlannerFromSlider();
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
            map.panTo(posicionTeorica, { animate: false }); 
        }
    }
}

// 9. Inicialización de la Aplicación
document.addEventListener('DOMContentLoaded', async () => {
    setupTabs();
    setupSlider();
    
    await loadPlannedRoute(); // Carga de archivo local (GeoJSON). Usamos await para que puntosRutaGeojson esté listo.
    
    // Si entramos directo en planificador, forzar update
    if (isPlannerMode) updatePlannerFromSlider();
    
    loadInitialData();      // SELECT a Supabase para cargar historial
    subscribeToRealTime();  // Abrir WebSocket para nuevos INSERTs
});
