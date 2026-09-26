"""Pasa a float16 los pesos grandes de un .tflite, como hace el conversor oficial.

Cada constante float32 grande se guarda como float16 y un DEQUANTIZE al principio del grafo la
devuelve a float32 al cargar: el modelo ocupa la mitad y calcula igual (salvo el redondeo de fp16).
"""
import sys

import flatbuffers
import numpy
from ai_edge_litert import schema_py_generated as schema

source_path, output_path = sys.argv[1], sys.argv[2]
minimum_elements = 1024

with open(source_path, 'rb') as model_file:
    model = schema.ModelT.InitFromPackedBuf(bytearray(model_file.read()), 0)
subgraph = model.subgraphs[0]

dequantize_code = schema.OperatorCodeT()
dequantize_code.builtinCode = schema.BuiltinOperator.DEQUANTIZE
dequantize_code.deprecatedBuiltinCode = schema.BuiltinOperator.DEQUANTIZE
dequantize_code.version = 2
model.operatorCodes.append(dequantize_code)
dequantize_opcode_index = len(model.operatorCodes) - 1

consumed_tensors = {index for operator in subgraph.operators for index in operator.inputs if index >= 0}
tensors_by_buffer = {}
for index, candidate in enumerate(subgraph.tensors):
    tensors_by_buffer.setdefault(candidate.buffer, []).append(index)
dequantize_operators = []
converted_count = 0
for tensor_index in sorted(consumed_tensors):
    tensor = subgraph.tensors[tensor_index]
    buffer = model.buffers[tensor.buffer]
    if tensor.type != schema.TensorType.FLOAT32 or buffer.data is None or len(buffer.data) < 4 * minimum_elements:
        continue
    float32_values = numpy.frombuffer(bytes(buffer.data), dtype=numpy.float32)
    half_tensor = schema.TensorT()
    half_tensor.shape = numpy.array(tensor.shape, dtype=numpy.int32)
    half_tensor.type = schema.TensorType.FLOAT16
    half_tensor.name = tensor.name + b'_fp16'
    half_buffer = schema.BufferT()
    half_buffer.data = numpy.frombuffer(float32_values.astype(numpy.float16).tobytes(), dtype=numpy.uint8)
    model.buffers.append(half_buffer)
    half_tensor.buffer = len(model.buffers) - 1
    subgraph.tensors.append(half_tensor)
    # El tensor original deja de ser constante: lo rellena el DEQUANTIZE. Su buffer fp32 se vacía
    # si no lo comparte otro tensor (si no, el fichero no encogería).
    if len(tensors_by_buffer[tensor.buffer]) == 1:
        buffer.data = None
    empty_buffer = schema.BufferT()
    model.buffers.append(empty_buffer)
    tensor.buffer = len(model.buffers) - 1
    dequantize = schema.OperatorT()
    dequantize.opcodeIndex = dequantize_opcode_index
    dequantize.inputs = numpy.array([len(subgraph.tensors) - 1], dtype=numpy.int32)
    dequantize.outputs = numpy.array([tensor_index], dtype=numpy.int32)
    dequantize_operators.append(dequantize)
    converted_count += 1
subgraph.operators = dequantize_operators + list(subgraph.operators)
print('constantes pasadas a float16:', converted_count)

builder = flatbuffers.Builder(1024)
builder.Finish(model.Pack(builder), file_identifier=b'TFL3')
with open(output_path, 'wb') as output_file:
    output_file.write(builder.Output())
