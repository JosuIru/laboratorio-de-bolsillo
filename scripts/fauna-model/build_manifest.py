"""Genera fauna-manifest.json: la descripción del modelo que descarga la app.

Uso: python build_manifest.py perch_europe_fp16.tflite [fauna-manifest.json]

Lee, de la carpeta actual, perch_europe_labels.txt (etiquetas en el orden de salida del modelo),
species_names.json (nombres comunes de las especies, de vernacular_names.py) y
general-sound-names.json (traducción de las etiquetas de sonidos generales de FSD50K).
"""
import hashlib
import json
import os
import sys

model_path = sys.argv[1]
manifest_path = sys.argv[2] if len(sys.argv) > 2 else 'fauna-manifest.json'

# Etiquetas de voz humana: si una de ellas sale entre las primeras, la app no guarda la detección
# (ni su embedding), para no registrar conversaciones. Mejor pasarse que quedarse corto.
human_voice_labels = {
    'Speech',
    'Male_speech_and_man_speaking',
    'Female_speech_and_woman_speaking',
    'Child_speech_and_kid_speaking',
    'Conversation',
    'Chatter',
    'Whispering',
    'Human_voice',
    'Speech_synthesizer',
    'Singing',
    'Male_singing',
    'Female_singing',
    'Shout',
    'Yell',
    'Screaming',
    'Laughter',
    'Giggle',
    'Chuckle_and_chortle',
    'Crying_and_sobbing',
    'Crowd',
    'Cheering',
}

# Grupos de GBIF a identificadores estables para la app.
group_by_gbif_class = {'Aves': 'bird', 'Amphibia': 'amphibian', 'Mammalia': 'mammal', 'Insecta': 'insect', 'Reptilia': 'reptile'}

labels = [line.strip() for line in open('perch_europe_labels.txt', encoding='utf-8') if line.strip()]
species_names = json.load(open('species_names.json', encoding='utf-8'))
general_sound_names = json.load(open('general-sound-names.json', encoding='utf-8'))

classes = []
for label in labels:
    if label in species_names:
        species_entry = species_names[label]
        classes.append({
            'label': label,
            'kind': 'species',
            'group': group_by_gbif_class[species_entry['grupo']],
            'names': {language: species_entry.get(language) for language in ('es', 'eu', 'en')},
        })
    elif label in general_sound_names:
        sound_entry = {
            'label': label,
            'kind': 'sound',
            'names': {language: general_sound_names[label].get(language) for language in ('es', 'eu', 'en')},
        }
        if label in human_voice_labels:
            sound_entry['isHumanVoice'] = True
        classes.append(sound_entry)
    else:
        raise SystemExit(f'Etiqueta sin nombres: {label}')

missing_voice_labels = human_voice_labels - set(labels)
if missing_voice_labels:
    raise SystemExit(f'Etiquetas de voz que no están en el modelo: {sorted(missing_voice_labels)}')

sha256 = hashlib.sha256()
with open(model_path, 'rb') as model_file:
    for chunk in iter(lambda: model_file.read(1 << 20), b''):
        sha256.update(chunk)

manifest = {
    'formatVersion': 1,
    'modelVersion': 'europa-1',
    'modelFile': os.path.basename(model_path),
    'modelBytes': os.path.getsize(model_path),
    'modelSha256': sha256.hexdigest(),
    'sampleRateHz': 32000,
    'windowSamples': 160000,
    'outputs': {'embedding': 0, 'spatialEmbedding': 1, 'spectrogram': 2, 'logits': 3},
    'license': 'Apache-2.0 (Google Perch 2.0)',
    'classes': classes,
}
with open(manifest_path, 'w', encoding='utf-8') as manifest_file:
    json.dump(manifest, manifest_file, ensure_ascii=False, separators=(',', ':'))
species_count = sum(1 for entry in classes if entry['kind'] == 'species')
print(f'{manifest_path}: {len(classes)} clases ({species_count} especies), {os.path.getsize(manifest_path)} bytes')
print('sha256', manifest['modelSha256'])
