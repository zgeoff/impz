const config = {
  // commitlint's default header pattern has no `!`, so a breaking header such as
  // `feat(daemon)!: …` parses with an empty subject and fails subject-empty.
  parserPreset: {
    parserOpts: {
      headerPattern: /^(?<type>\w*)(?:\((?<scope>.*)\))?!?: (?<subject>.*)$/u,
      breakingHeaderPattern: /^(?<type>\w*)(?:\((?<scope>.*)\))?!: (?<subject>.*)$/u,
      headerCorrespondence: ['type', 'scope', 'subject'],
    },
  },
  rules: {
    'body-leading-blank': [2, 'always'],
    'footer-leading-blank': [2, 'always'],
    'header-case': [2, 'always', 'lower-case'],
    'header-full-stop': [2, 'never', '.'],
    'header-max-length': [2, 'always', 72],
    'scope-case': [2, 'always', 'lower-case'],
    'subject-case': [2, 'always', 'lower-case'],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],
    'type-enum': [
      2,
      'always',
      [
        'build',
        'chore',
        'ci',
        'docs',
        'feat',
        'fix',
        'perf',
        'refactor',
        'revert',
        'style',
        'test',
      ],
    ],
    'type-case': [2, 'always', 'lower-case'],
  },
};

export default config;
