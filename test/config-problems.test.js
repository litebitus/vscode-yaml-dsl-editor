const test = require('node:test');
const assert = require('node:assert/strict');
const { Diagnostic, Position } = require('yaml-dsl-spec');
const { configProblemOf } = require('../lib/config-problems');

const at = (line, column, message) => Diagnostic.at(new Position('yaml-dsl.yml', line, column), message);
const spanOf = (problem) => [
  problem.range.start.line,
  problem.range.start.character,
  problem.range.end.line,
  problem.range.end.character,
];

test('a problem underlines the key, the plain or quoted scalar, or the flow collection at its place', () => {
  const text = [
    'dsls:',
    '  - file_exclude: []',
    '    id: "mock dsl" # named',
    '    scopes: { a: {b: 1}, c: [2] }',
    "    name: 'it''s' ",
    '    pattern: "a\\"b"',
    '    plain: one two  # trailing',
    '    unclosed: [a, b',
    '    quoted: ["a]", b] # after',
    '    open: "no end',
  ].join('\n');
  assert.deepEqual(spanOf(configProblemOf(text, at(9, 13, 'mock'))), [8, 12, 8, 21]);
  assert.deepEqual(spanOf(configProblemOf(text, at(10, 11, 'mock'))), [9, 10, 9, 17]);
  assert.deepEqual(spanOf(configProblemOf(text, at(2, 5, 'mock'))), [1, 4, 1, 16]);
  assert.deepEqual(spanOf(configProblemOf(text, at(3, 9, 'mock'))), [2, 8, 2, 18]);
  assert.deepEqual(spanOf(configProblemOf(text, at(4, 13, 'mock'))), [3, 12, 3, 33]);
  assert.deepEqual(spanOf(configProblemOf(text, at(5, 11, 'mock'))), [4, 10, 4, 17]);
  assert.deepEqual(spanOf(configProblemOf(text, at(6, 14, 'mock'))), [5, 13, 5, 19]);
  assert.deepEqual(spanOf(configProblemOf(text, at(7, 12, 'mock'))), [6, 11, 6, 18]);
  assert.deepEqual(spanOf(configProblemOf(text, at(8, 15, 'mock'))), [7, 14, 7, 19]);
});

test('a column counted in characters is placed in the editor\'s UTF-16 offsets', () => {
  const text = '😀: x\nkey: "😀😀"\n';
  assert.deepEqual(spanOf(configProblemOf(text, at(1, 4, 'mock'))), [0, 4, 0, 5]);
  assert.deepEqual(spanOf(configProblemOf(text, at(2, 6, 'mock'))), [1, 5, 1, 11]);
});

test('a problem shows its message, then its label and help, and a problem with no place is on the first line', () => {
  const placed = at(1, 1, 'field `x` is not allowed').withLabel('`dsls[0]` has no field `x`').withHelp('did you mean `y`?');
  assert.equal(configProblemOf('x: 1\n', placed).message,
    'field `x` is not allowed\n\n`dsls[0]` has no field `x`; did you mean `y`?');
  assert.equal(configProblemOf('x: 1\n', at(1, 1, 'duplicate key `x`')).message, 'duplicate key `x`');
  const unplaced = configProblemOf('x: 1\n', Diagnostic.unplaced('mock problem'));
  assert.deepEqual(spanOf(unplaced), [0, 0, 0, 0]);
  assert.deepEqual(spanOf(configProblemOf('x: 1\r\n', at(1, 1, 'mock'))), [0, 0, 0, 1]);
});
