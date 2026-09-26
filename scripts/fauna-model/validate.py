"""Compara Perch completo y recortado sobre grabaciones reales: top 5 y diferencia máxima de logits.

Las grabaciones van en audio/<Género_especie>.f32 (float32 mono a 32 kHz, p. ej. con
`ffmpeg -i canto.ogg -ac 1 -ar 32000 -f f32le audio/Turdus_merula.f32`). Los modelos se eligen con
MODELO_REFERENCIA (por defecto perch_v2.tflite) y MODELO_PRUEBA (por defecto perch_europe.tflite).
"""
import glob
import json
import os
import time
import numpy
from ai_edge_litert.interpreter import Interpreter

window_samples = 160_000
perch_labels = [line.strip() for line in open('labels.csv', encoding='utf-8')][1:]
europe_labels = [line.strip() for line in open('perch_europe_labels.txt', encoding='utf-8') if line.strip()]
europe_species = json.load(open('europe_species.json', encoding='utf-8'))
full_indices = numpy.array([perch_labels.index(label) for label in europe_labels])

def loudest_window(samples):
    if len(samples) <= window_samples:
        return numpy.pad(samples, (0, window_samples - len(samples)))
    hop = 16_000
    energies = [numpy.sum(samples[start:start + window_samples] ** 2) for start in range(0, len(samples) - window_samples + 1, hop)]
    start = int(numpy.argmax(energies)) * hop
    return samples[start:start + window_samples]

def make_runner(path):
    interpreter = Interpreter(model_path=path, num_threads=2)
    interpreter.allocate_tensors()
    input_index = interpreter.get_input_details()[0]['index']
    output_by_name = {detail['name']: detail['index'] for detail in interpreter.get_output_details()}
    def run(window):
        interpreter.set_tensor(input_index, window[numpy.newaxis].astype(numpy.float32))
        started = time.perf_counter()
        interpreter.invoke()
        elapsed = time.perf_counter() - started
        return interpreter.get_tensor(output_by_name['StatefulPartitionedCall:1'])[0], interpreter.get_tensor(output_by_name['StatefulPartitionedCall:0'])[0], elapsed
    return run

run_full = make_runner(os.environ.get('MODELO_REFERENCIA', 'perch_v2.tflite'))
run_europe = make_runner(os.environ.get('MODELO_PRUEBA', 'perch_europe.tflite'))
def display(label):
    vernacular = europe_species.get(label, {}).get('vernacular')
    return f'{label}' + (f' ({vernacular})' if vernacular else '')
for audio_path in sorted(glob.glob('audio/*.f32')):
    expected = audio_path.split('/')[-1][:-4].replace('_', ' ')
    window = loudest_window(numpy.fromfile(audio_path, dtype=numpy.float32))
    full_logits, full_embedding, full_seconds = run_full(window)
    europe_logits, europe_embedding, europe_seconds = run_europe(window)
    reference_logits = full_logits if len(full_logits) == len(europe_logits) else full_logits[full_indices]
    difference = numpy.max(numpy.abs(reference_logits - europe_logits))
    top = numpy.argsort(europe_logits)[::-1][:5]
    full_top = (europe_labels if len(full_logits) == len(europe_labels) else perch_labels)[int(numpy.argmax(full_logits))]
    rank = int(numpy.where(numpy.argsort(europe_logits)[::-1] == europe_labels.index(expected))[0][0]) + 1 if expected in europe_labels else None
    print(f'\n== {expected}: puesto {rank} | dif. máx. {difference:.2e} | completo {full_seconds:.2f}s recortado {europe_seconds:.2f}s | top global (14795): {full_top}')
    for index in top:
        print(f'   {europe_logits[index]:6.2f}  {display(europe_labels[index])}')
