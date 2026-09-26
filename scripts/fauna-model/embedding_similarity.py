"""Similitud coseno entre resúmenes (embeddings) de Perch: misma grabación frente a grabaciones distintas."""
import glob, itertools
import numpy
from ai_edge_litert.interpreter import Interpreter

interpreter = Interpreter(model_path='perch_europe_fp16.tflite', num_threads=2)
interpreter.allocate_tensors()
input_index = interpreter.get_input_details()[0]['index']
embedding_index = next(detail['index'] for detail in interpreter.get_output_details() if detail['name'] == 'StatefulPartitionedCall:0')

def embeddings_for(path, window_count=4):
    samples = numpy.fromfile(path, dtype=numpy.float32)
    starts = numpy.linspace(0, max(0, len(samples) - 160_000), window_count).astype(int)
    result = []
    for start in starts:
        window = samples[start:start + 160_000]
        window = numpy.pad(window, (0, 160_000 - len(window)))
        interpreter.set_tensor(input_index, window[numpy.newaxis])
        interpreter.invoke()
        embedding = interpreter.get_tensor(embedding_index)[0].copy()
        result.append(embedding / numpy.linalg.norm(embedding))
    return result

embeddings_by_recording = {path.split('/')[-1][:-4]: embeddings_for(path) for path in sorted(glob.glob('audio/*.f32'))}
same, different = [], []
for name, embeddings in embeddings_by_recording.items():
    same += [float(a @ b) for a, b in itertools.combinations(embeddings, 2)]
for (name_a, emb_a), (name_b, emb_b) in itertools.combinations(embeddings_by_recording.items(), 2):
    different += [float(a @ b) for a in emb_a for b in emb_b]
for title, values in (('misma grabación', same), ('distintas', different)):
    values = numpy.array(values)
    print(f'{title:16s} n={len(values):3d}  min {values.min():.3f}  p10 {numpy.percentile(values,10):.3f}  mediana {numpy.median(values):.3f}  p90 {numpy.percentile(values,90):.3f}  max {values.max():.3f}')
silence = numpy.zeros(160_000, dtype=numpy.float32) + numpy.random.default_rng(1).normal(0, 0.001, 160_000).astype(numpy.float32)
interpreter.set_tensor(input_index, silence[numpy.newaxis]); interpreter.invoke()
silence_embedding = interpreter.get_tensor(embedding_index)[0]; silence_embedding /= numpy.linalg.norm(silence_embedding)
print('ruido de fondo vs grabaciones: max', max(float(silence_embedding @ e) for embs in embeddings_by_recording.values() for e in embs))
