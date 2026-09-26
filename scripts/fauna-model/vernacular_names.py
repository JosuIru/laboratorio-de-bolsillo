"""Nombres comunes en castellano, euskera e inglés de las especies europeas (GBIF), con su grupo."""
import concurrent.futures, json, urllib.request, collections

europe_species = json.load(open('europe_species.json', encoding='utf-8'))
preferred_sources = ('Catalogue of Life', 'Integrated Taxonomic Information System', 'IOC World Bird List')

def names_for(item):
    scientific_name, info = item
    url = f"https://api.gbif.org/v1/species/{info['gbif']}/vernacularNames?limit=300"
    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            results = json.load(response)['results']
    except Exception:
        results = []
    names_by_language = collections.defaultdict(list)
    for result in results:
        names_by_language[result.get('language')].append(result['vernacularName'])
    def pick(language):
        candidates = names_by_language.get(language, [])
        if not candidates:
            return None
        # El más repetido entre fuentes, con mayúscula inicial.
        most_common = collections.Counter(name.strip() for name in candidates).most_common(1)[0][0]
        return most_common[:1].upper() + most_common[1:]
    return scientific_name, {'grupo': info['grupo'], 'es': pick('spa'), 'eu': pick('eus'), 'en': pick('eng') or info.get('vernacular')}

with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
    names = dict(executor.map(names_for, europe_species.items()))
json.dump(names, open('species_names.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
for language in ('es', 'eu', 'en'):
    print(language, sum(1 for entry in names.values() if entry[language]), 'de', len(names))
for scientific_name in ['Turdus merula', 'Erithacus rubecula', 'Bufo bufo', 'Gryllus campestris', 'Parus major']:
    print(scientific_name, names[scientific_name])
