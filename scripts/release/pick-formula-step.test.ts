import { expect, test } from 'bun:test';
import { pickFormulaStep } from './pick-formula-step';

test('it fails a tree without build-formula.sh', () => {
  expect(
    pickFormulaStep({ version: '3.1.4', generator: null, formula: null, hasChange: null }),
  ).toStrictEqual({ kind: 'fail', message: 'the checked-out tree has no build-formula.sh' });
});

test('it generates the formula first', () => {
  expect(
    pickFormulaStep({
      version: '3.1.4',
      generator: 'scripts/release/build-formula.sh',
      formula: null,
      hasChange: null,
    }),
  ).toStrictEqual({ kind: 'generate', generator: 'scripts/release/build-formula.sh' });
});

test('it fails a formula with no class', () => {
  expect(
    pickFormulaStep({
      version: '3.1.4',
      generator: 'scripts/release/build-formula.sh',
      formula: 'oops\n',
      hasChange: null,
    }),
  ).toStrictEqual({
    kind: 'fail',
    message: 'scripts/release/build-formula.sh printed no formula class',
  });
});

test('it leaves the formula of a tag from before the rename out of the tap', () => {
  expect(
    pickFormulaStep({
      version: '1.6.0',
      generator: 'scripts/build-formula.sh',
      formula: 'class Imp < Formula\nend\n',
      hasChange: null,
    }),
  ).toStrictEqual({
    kind: 'finish',
    message:
      'scripts/build-formula.sh printed class Imp; the tap offers only impz, so the formula stays',
  });
});

test('it stages an impz formula', () => {
  expect(
    pickFormulaStep({
      version: '3.1.4',
      generator: 'scripts/release/build-formula.sh',
      formula: 'class Impz < Formula\nend\n',
      hasChange: null,
    }),
  ).toStrictEqual({ kind: 'stage', formula: 'class Impz < Formula\nend\n' });
});

test('it publishes nothing when the tap holds the formula already', () => {
  expect(
    pickFormulaStep({
      version: '3.1.4',
      generator: 'scripts/release/build-formula.sh',
      formula: 'class Impz < Formula\nend\n',
      hasChange: false,
    }),
  ).toStrictEqual({ kind: 'finish', message: 'the formula is at 3.1.4 already' });
});

test('it publishes a changed formula under the version', () => {
  expect(
    pickFormulaStep({
      version: '3.1.4',
      generator: 'scripts/release/build-formula.sh',
      formula: 'class Impz < Formula\nend\n',
      hasChange: true,
    }),
  ).toStrictEqual({ kind: 'publish', subject: 'impz 3.1.4' });
});
