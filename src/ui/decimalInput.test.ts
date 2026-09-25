import { parseDecimalInput } from './decimalInput';

describe('parseDecimalInput', () => {
  it.each([
    ['65', 65],
    ['65,5', 65.5],
    [' 72.25 ', 72.25],
    ['-3,5', -3.5],
    ['abc', null],
    ['', null],
    ['6,5,1', null],
  ])('%j → %p', (inputText, expectedNumber) => {
    expect(parseDecimalInput(inputText)).toBe(expectedNumber);
  });
});
