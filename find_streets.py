import urllib.request, json
query = '[out:json];area[name="San José de la Rinconada"]->.a;(way(area.a)[name~"San Juan|Blas Infante|Lepanto|Cultura|Casa del Sueño",i];node(w););out body;'
url = 'https://overpass-api.de/api/interpreter'
req = urllib.request.Request(url, data=query.encode('utf-8'))
try:
    with urllib.request.urlopen(req) as response:
        print(response.read().decode())
except Exception as e:
    print(e)
