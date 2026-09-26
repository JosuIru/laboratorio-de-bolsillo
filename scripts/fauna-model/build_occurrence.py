"""Datos del filtro por lugar y época de «¿Quién canta?» a partir de GBIF.

- Rejilla de celdas de 2° sobre Europa: qué especies del modelo tienen registros en cada celda
  (o en una vecina, para no penalizar por huecos de muestreo).
- Actividad relativa por mes de cada especie en Europa (100 = el mes con más registros).
"""
import base64, concurrent.futures, json, math, time, urllib.request

cell_size_degrees = 2
latitude_min, latitude_max = 34, 72
longitude_min, longitude_max = -26, 46
rows = (latitude_max - latitude_min) // cell_size_degrees
columns = (longitude_max - longitude_min) // cell_size_degrees
minimum_records_per_species = 3
minimum_species_for_data = 15  # celdas con menos especies del modelo = sin datos fiables (mar, huecos)
taxon_keys = [212, 131, 359, 216]

europe_species = json.load(open('europe_species.json', encoding='utf-8'))
species_labels = sorted(europe_species)
label_by_gbif_key = {info['gbif']: label for label, info in europe_species.items()}
bit_index_by_label = {label: index for index, label in enumerate(species_labels)}

def fetch_json(url, attempts=4):
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=90) as response:
                return json.load(response)
        except Exception:
            time.sleep(3 * (attempt + 1))
    return None

def cell_species(cell):
    row, column = cell
    south = latitude_min + row * cell_size_degrees
    west = longitude_min + column * cell_size_degrees
    taxon_query = ''.join(f'&taxonKey={taxon_key}' for taxon_key in taxon_keys)
    url = (f'https://api.gbif.org/v1/occurrence/search?decimalLatitude={south},{south + cell_size_degrees}'
           f'&decimalLongitude={west},{west + cell_size_degrees}{taxon_query}'
           f'&facet=speciesKey&facetLimit=40000&facetMincount={minimum_records_per_species}&limit=0')
    result = fetch_json(url)
    if not result or not result.get('facets'):
        return cell, set()
    record_counts = {label_by_gbif_key[int(count['name'])]: count['count'] for count in result['facets'][0]['counts'] if int(count['name']) in label_by_gbif_key}
    return cell, record_counts

cells = [(row, column) for row in range(rows) for column in range(columns)]
species_by_cell = {}
started = time.time()
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
    for done_count, (cell, present) in enumerate(executor.map(cell_species, cells), start=1):
        species_by_cell[cell] = present
        if done_count % 100 == 0:
            print(f'celdas {done_count}/{len(cells)} ({time.time() - started:.0f} s)', flush=True)

json.dump({f'{row}_{column}': counts for (row, column), counts in species_by_cell.items()}, open('cell_counts.json', 'w'))
print('recuentos guardados en cell_counts.json')

def monthly_activity(label):
    url = (f"https://api.gbif.org/v1/occurrence/search?taxonKey={europe_species[label]['gbif']}"
           f'&continent=EUROPE&facet=month&facetLimit=12&limit=0')
    result = fetch_json(url)
    counts = [0] * 12
    if result and result.get('facets'):
        for count in result['facets'][0]['counts']:
            counts[int(count['name']) - 1] = count['count']
    peak = max(counts) or 1
    return label, [round(100 * count / peak) for count in counts]

with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
    monthly = dict(executor.map(monthly_activity, species_labels))

json.dump(monthly, open('monthly_activity.json', 'w', encoding='utf-8'))
print('actividad mensual guardada')
