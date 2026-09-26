"""Especies con registros en Europa (GBIF) que están entre las clases de Perch 2.0."""
import concurrent.futures
import json
import urllib.request

minimum_occurrences = 200
taxon_groups = {'Aves': 212, 'Amphibia': 131, 'Mammalia': 359, 'Insecta': 216, 'Reptilia': 358}
perch_labels = [line.strip() for line in open('labels.csv', encoding='utf-8')][1:]
perch_label_set = set(perch_labels)

def fetch_json(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.load(response)

species_keys = {}
for group_name, taxon_key in taxon_groups.items():
    url = (f'https://api.gbif.org/v1/occurrence/search?continent=EUROPE&taxonKey={taxon_key}'
           f'&facet=speciesKey&facetLimit=6000&facetMincount={minimum_occurrences}&limit=0')
    counts = fetch_json(url)['facets'][0]['counts']
    print(group_name, len(counts), 'especies con', minimum_occurrences, 'registros o más')
    for count in counts:
        species_keys[int(count['name'])] = (group_name, count['count'])

def species_name(species_key):
    try:
        return species_key, fetch_json(f'https://api.gbif.org/v1/species/{species_key}')
    except Exception:
        return species_key, None

matched = {}
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
    for species_key, record in executor.map(species_name, species_keys):
        if not record:
            continue
        canonical_name = record.get('canonicalName') or record.get('species')
        if canonical_name in perch_label_set:
            matched[canonical_name] = {'grupo': species_keys[species_key][0], 'registros': species_keys[species_key][1],
                                       'gbif': species_key, 'vernacular': record.get('vernacularName')}
print('coincidencias con Perch:', len(matched))
by_group = {}
for name, info in matched.items():
    by_group[info['grupo']] = by_group.get(info['grupo'], 0) + 1
print(by_group)
json.dump(matched, open('europe_species.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
