"""Compone fauna-occurrence-europa-1.json a partir de los recuentos de GBIF por celda.

Una especie cuenta como presente en una celda si sus registros son al menos `relative_threshold`
del total de registros (de especies del modelo) de esa celda, y como mínimo `minimum_records`.
Así los ejemplares perdidos y los de zoológicos (un flamenco en Oslo) no cuentan. Luego se
suman las celdas vecinas, para no penalizar huecos de muestreo.
"""
import base64, json, math, sys, time

relative_threshold = float(sys.argv[1]) if len(sys.argv) > 1 else 0.0005
minimum_records = 5
minimum_species_for_data = 15
cell_size_degrees, latitude_min, longitude_min, rows, columns = 2, 34, -26, 19, 36

cell_counts = json.load(open('cell_counts.json'))
monthly = json.load(open('monthly_activity.json', encoding='utf-8'))
species_labels = sorted(json.load(open('europe_species.json', encoding='utf-8')))
bit_index_by_label = {label: index for index, label in enumerate(species_labels)}

present_by_cell = {}
for key, counts in cell_counts.items():
    total_records = sum(counts.values())
    present_by_cell[key] = {label for label, count in counts.items() if count >= max(minimum_records, relative_threshold * total_records)}

def neighbourhood(key):
    row, column = map(int, key.split('_'))
    labels = set()
    for row_offset in (-1, 0, 1):
        for column_offset in (-1, 0, 1):
            labels |= present_by_cell.get(f'{row + row_offset}_{column + column_offset}', set())
    return labels

cells_output = {}
for key, present in present_by_cell.items():
    if len(present) < minimum_species_for_data:
        continue
    bitset = bytearray(math.ceil(len(species_labels) / 8))
    for label in neighbourhood(key):
        bitset[bit_index_by_label[label] >> 3] |= 1 << (bit_index_by_label[label] & 7)
    cells_output[key] = base64.b64encode(bytes(bitset)).decode('ascii')

output = {'formatVersion': 1, 'cellSizeDegrees': cell_size_degrees, 'latitudeMin': latitude_min, 'longitudeMin': longitude_min,
          'rows': rows, 'columns': columns, 'speciesLabels': species_labels, 'cells': cells_output, 'monthlyActivity': monthly,
          'source': 'GBIF.org (occurrence search API), consultado el ' + time.strftime('%Y-%m-%d'),
          'relativeThreshold': relative_threshold}
json.dump(output, open('fauna-occurrence-europa-1.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

def present(lat, lon, label):
    key = f'{int((lat - latitude_min) // cell_size_degrees)}_{int((lon - longitude_min) // cell_size_degrees)}'
    if key not in cells_output:
        return '·'
    bits = base64.b64decode(cells_output[key]); index = bit_index_by_label[label]
    return 'X' if bits[index >> 3] & (1 << (index & 7)) else '-'
places = {'Bilbao': (43.26, -2.93), 'Doñana': (37.0, -6.4), 'Madrid': (40.4, -3.7), 'Oslo': (59.9, 10.7), 'Helsinki': (60.2, 24.9), 'Atenas': (38.0, 23.7)}
print(f'umbral {relative_threshold}: celdas {len(cells_output)}  ' + ' '.join(places))
for label in ['Phoenicopterus roseus', 'Turdus merula', 'Luscinia megarhynchos', 'Tetrax tetrax', 'Grus grus', 'Picus sharpei', 'Ficedula hypoleuca', 'Pelophylax perezi', 'Cettia cetti']:
    if label in bit_index_by_label:
        print('  ' + label.ljust(24) + '  '.join(present(*coords, label).center(len(name)) for name, coords in places.items()))
counts = [bin(int.from_bytes(base64.b64decode(value), 'little')).count('1') for value in cells_output.values()]
print('  especies por celda: mediana', sorted(counts)[len(counts) // 2], 'máx', max(counts))
