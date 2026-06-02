/**
 * Unit tests for the Allow_List import extractor (Req 18.6, Property 39).
 *
 * The extractor is the lexical preflight that lets the Code_Sandbox reject code
 * importing a non-allow-listed package before it runs. These tests pin its
 * behaviour per runtime — Python, Node, shell, SQL — including the conservative,
 * fail-safe edges (comments stripped, relatives ignored, scoped Node packages
 * preserved, deterministic sorted output).
 */

import { describe, expect, it } from 'vitest';

import { extractImports } from './imports.js';

describe('extractImports — python (Req 18.6)', () => {
  it('extracts top-level packages from import and from-import statements', () => {
    const source = [
      'import os',
      'import sys, json',
      'from collections import OrderedDict',
      'from a.b.c import thing',
      'import numpy as np',
    ].join('\n');
    expect(extractImports('python', source)).toEqual(['a', 'collections', 'json', 'numpy', 'os', 'sys']);
  });

  it('ignores relative imports and imports mentioned only in comments', () => {
    const source = [
      'from . import sibling',
      'from .pkg import x',
      '# import requests  -- this is a comment',
      'import real_pkg  # trailing comment',
    ].join('\n');
    expect(extractImports('python', source)).toEqual(['real_pkg']);
  });
});

describe('extractImports — node (Req 18.6)', () => {
  it('extracts bare package names from import/require/dynamic-import', () => {
    const source = [
      "import fs from 'node:fs';",
      "import { z } from 'zod';",
      "const lodash = require('lodash/fp');",
      "const dyn = await import('@scope/pkg/sub');",
      "export { x } from 'rxjs';",
    ].join('\n');
    expect(extractImports('node', source)).toEqual([
      '@scope/pkg',
      'lodash',
      'node:fs',
      'rxjs',
      'zod',
    ]);
  });

  it('ignores relative and absolute path imports', () => {
    const source = [
      "import a from './local.js';",
      "import b from '../parent.js';",
      "import c from '/abs/path.js';",
      "import real from 'realpkg';",
    ].join('\n');
    expect(extractImports('node', source)).toEqual(['realpkg']);
  });

  it('does not treat a specifier inside a // comment as an import', () => {
    const source = ["// import secret from 'evil'", "import ok from 'okpkg';"].join('\n');
    expect(extractImports('node', source)).toEqual(['okpkg']);
  });
});

describe('extractImports — shell (Req 18.6)', () => {
  it('extracts the command words a script invokes, across pipes and separators', () => {
    const source = ['curl http://x | grep foo', 'FOO=bar python script.py', 'sudo rm -rf /tmp/x'].join(
      '\n',
    );
    expect(extractImports('shell', source)).toEqual(['curl', 'grep', 'python', 'rm']);
  });
});

describe('extractImports — sql (Req 18.6)', () => {
  it('has no import concept and always returns an empty set', () => {
    expect(extractImports('sql', 'SELECT * FROM staging.users WHERE id = 1')).toEqual([]);
  });
});
