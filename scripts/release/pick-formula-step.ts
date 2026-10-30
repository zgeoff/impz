export interface FormulaFacts {
  readonly version: string;
  readonly generator: string | null;
  formula: string | null;
  hasChange: boolean | null;
}

export type FormulaStep =
  | { readonly kind: 'generate'; readonly generator: string }
  | { readonly kind: 'stage'; readonly formula: string }
  | { readonly kind: 'publish'; readonly subject: string }
  | { readonly kind: 'finish'; readonly message: string }
  | { readonly kind: 'fail'; readonly message: string };

const classPattern = /^class (?<name>[A-Za-z0-9]+) < Formula$/mu;

// The tap offers only impz. Homebrew loads a formula only from the file its class names, and a tag
// from before the rename to impz generates class Imp, so its formula stays out of the tap.
export function pickFormulaStep(facts: FormulaFacts): FormulaStep {
  if (facts.generator === null) {
    return { kind: 'fail', message: 'the checked-out tree has no build-formula.sh' };
  }

  if (facts.formula === null) {
    return { kind: 'generate', generator: facts.generator };
  }

  const name = classPattern.exec(facts.formula)?.groups?.['name'];

  if (name === undefined) {
    return { kind: 'fail', message: `${facts.generator} printed no formula class` };
  }

  if (name !== 'Impz') {
    return {
      kind: 'finish',
      message: `${facts.generator} printed class ${name}; the tap offers only impz, so the formula stays`,
    };
  }

  if (facts.hasChange === null) {
    return { kind: 'stage', formula: facts.formula };
  }

  if (!facts.hasChange) {
    return { kind: 'finish', message: `the formula is at ${facts.version} already` };
  }

  return { kind: 'publish', subject: `impz ${facts.version}` };
}
