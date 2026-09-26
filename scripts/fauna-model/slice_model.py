"""Recorta la cabeza ProtoPNet de Perch 2.0 a un subconjunto de clases, editando el .tflite directamente.

Sustituye las constantes de prototipos [C,1536,4], pesos [1,C,4] y sesgos [1,C] por las filas de las
clases elegidas y corrige las formas que dependen de C (C y 4·C) en constantes y tensores de la cabeza.
"""
import json
import sys

import flatbuffers
import numpy
from ai_edge_litert import schema_py_generated as schema

source_path, output_path, labels_output_path = sys.argv[1], sys.argv[2], sys.argv[3]
perch_labels = [line.strip() for line in open('labels.csv', encoding='utf-8')][1:]
full_class_count = len(perch_labels)
europe_species = json.load(open('europe_species.json', encoding='utf-8'))
general_sound_labels = [label for label in perch_labels if len(label.split(' ')) != 2]
chosen_labels = sorted(set(europe_species) | set(general_sound_labels), key=perch_labels.index)
chosen_indices = numpy.array([perch_labels.index(label) for label in chosen_labels])
chosen_count = len(chosen_indices)
print('clases elegidas', chosen_count, 'de', full_class_count)

with open(source_path, 'rb') as model_file:
    model = schema.ModelT.InitFromPackedBuf(bytearray(model_file.read()), 0)
subgraph = model.subgraphs[0]

def constant_array(tensor_index, dtype):
    return numpy.frombuffer(bytes(model.buffers[subgraph.tensors[tensor_index].buffer].data), dtype=dtype)

def set_constant(tensor_index, values):
    tensor = subgraph.tensors[tensor_index]
    model.buffers[tensor.buffer].data = numpy.frombuffer(numpy.ascontiguousarray(values).tobytes(), dtype=numpy.uint8)
    tensor.shape = numpy.array(values.shape, dtype=numpy.int32)
    tensor.shapeSignature = None

# Localiza las constantes por forma: son únicas en el modelo.
tensor_by_shape = {}
for tensor_index, tensor in enumerate(subgraph.tensors):
    tensor_by_shape.setdefault(tuple(int(dimension) for dimension in tensor.shape), []).append(tensor_index)
prototype_tensor = next(index for index in tensor_by_shape[(full_class_count, 1536, 4)] if model.buffers[subgraph.tensors[index].buffer].data is not None)
weight_tensor = next(index for index in tensor_by_shape[(1, full_class_count, 4)] if model.buffers[subgraph.tensors[index].buffer].data is not None)
bias_tensor = next(index for index in tensor_by_shape[(1, full_class_count)] if model.buffers[subgraph.tensors[index].buffer].data is not None)

prototypes = constant_array(prototype_tensor, numpy.float32).reshape(full_class_count, 1536, 4)
weights = constant_array(weight_tensor, numpy.float32).reshape(1, full_class_count, 4)
biases = constant_array(bias_tensor, numpy.float32).reshape(1, full_class_count)
set_constant(prototype_tensor, prototypes[chosen_indices])
set_constant(weight_tensor, weights[:, chosen_indices])
set_constant(bias_tensor, biases[:, chosen_indices])

# Constantes enteras pequeñas con C o 4·C (formas de RESHAPE, BROADCAST_TO…) y formas estáticas de tensores.
replaced_constants = 0
for tensor_index, tensor in enumerate(subgraph.tensors):
    buffer = model.buffers[tensor.buffer]
    if tensor.type == schema.TensorType.INT32 and buffer.data is not None and len(buffer.data) <= 64:
        values = numpy.frombuffer(bytes(buffer.data), dtype=numpy.int32).copy()
        if (values == full_class_count).any() or (values == 4 * full_class_count).any():
            values[values == full_class_count] = chosen_count
            values[values == 4 * full_class_count] = 4 * chosen_count
            buffer.data = numpy.frombuffer(values.tobytes(), dtype=numpy.uint8)
            replaced_constants += 1
    for attribute in ('shape', 'shapeSignature'):
        dimensions = getattr(tensor, attribute)
        if dimensions is not None and len(dimensions):
            dimensions = numpy.array(dimensions, dtype=numpy.int32)
            dimensions[dimensions == full_class_count] = chosen_count
            dimensions[dimensions == 4 * full_class_count] = 4 * chosen_count
            setattr(tensor, attribute, dimensions)
print('constantes de forma corregidas', replaced_constants)

builder = flatbuffers.Builder(1024)
builder.Finish(model.Pack(builder), file_identifier=b'TFL3')
with open(output_path, 'wb') as output_file:
    output_file.write(builder.Output())
with open(labels_output_path, 'w', encoding='utf-8') as labels_file:
    labels_file.write('\n'.join(chosen_labels) + '\n')
print('escrito', output_path)
