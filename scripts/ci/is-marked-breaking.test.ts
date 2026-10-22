import { expect, test } from 'bun:test';
import { isMarkedBreaking } from './is-marked-breaking';

interface IsMarkedBreakingRow {
  readonly label: string;
  readonly title: string;
  readonly commits: readonly string[];
  readonly body: string;
  readonly expected: boolean;
}

// Each row's verdict is what release-please 17.11.2 parses from the squash message GitHub builds
// for that row.
test.each<IsMarkedBreakingRow>([
  {
    label: 'a lone commit with a ! subject',
    title: 'feat: a',
    commits: ['feat(api)!: drop imps.get'],
    body: '',
    expected: true,
  },
  {
    label: 'a lone commit of any type with a ! subject',
    title: 'chore: a',
    commits: ['chore!: drop imps.get'],
    body: '',
    expected: true,
  },
  {
    label: 'a lone commit under a ! PR title',
    title: 'feat!: drop imps.get',
    commits: ['feat: drop imps.get'],
    body: '',
    expected: false,
  },
  {
    label: 'several commits under a ! PR title',
    title: 'feat(#740)!: drop imps.get',
    commits: ['feat: a', 'fix: b'],
    body: '',
    expected: true,
  },
  {
    label: 'several commits with ! on a later one only',
    title: 'feat: a',
    commits: ['feat: a', 'feat!: b'],
    body: '',
    expected: false,
  },
  {
    label: 'a footer in a lone commit',
    title: 'feat: a',
    commits: ['feat: a\n\nBREAKING CHANGE: imps.get is gone'],
    body: '',
    expected: true,
  },
  {
    label: 'a footer in an earlier commit of several',
    title: 'feat: a',
    commits: ['feat: a\n\nBREAKING CHANGE: gone', 'fix: b'],
    body: '',
    expected: true,
  },
  {
    label: 'a footer with no space after the colon',
    title: 'feat: a',
    commits: ['feat: a\n\nBREAKING CHANGE:gone'],
    body: '',
    expected: true,
  },
  {
    label: 'a footer with no text',
    title: 'feat: a',
    commits: ['feat: a\n\nBREAKING CHANGE: '],
    body: '',
    expected: false,
  },
  {
    label: 'the words mid-line',
    title: 'feat: a',
    commits: ['feat: a\n\nsee the BREAKING CHANGE: inline'],
    body: '',
    expected: false,
  },
  {
    label: 'the hyphenated token mid-line',
    title: 'feat: a',
    commits: ['feat: a\n\nthis has BREAKING-CHANGE: x inline'],
    body: '',
    expected: true,
  },
  {
    label: 'a footer in lower case',
    title: 'feat: a',
    commits: ['feat: a\n\nbreaking change: gone'],
    body: '',
    expected: false,
  },
  {
    label: 'an override in the PR body',
    title: 'feat: a',
    commits: ['feat: a'],
    body: 'BEGIN_COMMIT_OVERRIDE\nfeat!: drop imps.get\nEND_COMMIT_OVERRIDE',
    expected: true,
  },
  {
    label: 'an override that hides a ! commit',
    title: 'feat: a',
    commits: ['feat!: a'],
    body: 'BEGIN_COMMIT_OVERRIDE\nfeat: a\nEND_COMMIT_OVERRIDE',
    expected: false,
  },
  {
    label: 'a plain feat',
    title: 'feat: add imps.list',
    commits: ['feat: add imps.list'],
    body: '',
    expected: false,
  },
])(
  'it marks a PR breaking exactly when release-please reads its squash message so, given $label',
  (row) => {
    expect(
      isMarkedBreaking({ number: 5, title: row.title, body: row.body, commits: row.commits }),
    ).toBe(row.expected);
  },
);
