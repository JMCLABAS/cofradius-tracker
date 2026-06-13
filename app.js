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

// Capa base de ESRI World Street Map (Tonos cálidos y calles extremadamente visibles)
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, Esri Japan, METI, Esri China (Hong Kong), Esri (Thailand), TomTom, 2012',
    maxZoom: 19
}).addTo(map);

// 3. Variables de Estado
let currentMarker = null;
let pathPolyline = null;
let positions = []; // Array de coordenadas [lat, lng]
let lastUpdateTime = null; // Guardará la fecha UTC de la última posición
let counterInterval = null;

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
        // Es un warning porque la app debe seguir funcionando aunque no haya ruta planificada
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

// 8. Inicialización de la Aplicación
document.addEventListener('DOMContentLoaded', () => {
    loadPlannedRoute();     // Carga de archivo local (GeoJSON)
    loadInitialData();      // SELECT a Supabase para cargar historial
    subscribeToRealTime();  // Abrir WebSocket para nuevos INSERTs
});
