import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'acorn';
import jsx from 'acorn-jsx';
import postcss from 'postcss';

export const LEGACY_ENTRY_FILE = 'src/ui/sunMoonEntry.js';
export const LEGACY_APIS = Object.freeze(['renderSunBadge', 'renderMoonPanel']);
export const LEGACY_OVERVIEW_IDS = Object.freeze([
  'globeSunMount',
  'globeMoonRoot',
  'globeMoonPanel',
]);
export const LEGACY_DOM_IDS = Object.freeze([
  ...LEGACY_OVERVIEW_IDS,
  'globeSunBadge',
  'globeMoonToggle',
]);
export const LEGACY_CLASS_PREFIXES = Object.freeze([
  'globe-moon-',
  'three-globe-sun-',
  'moon-solar-',
]);
export const LEGACY_CLASSES = Object.freeze([
  'moon-drag-only',
  'moon-solar',
  'three-globe-sun',
  'three-globe-moon',
  'vintage-moon-toggle',
  'vintage-moon-sky',
  'vintage-crescent',
  'vintage-crater',
  'vintage-star',
  'moon-core',
  'moon-copy',
  'moon-stat',
  'moon-section-title',
]);

const sourceParser = Parser.extend(jsx());
const overviewFile = 'src/pages/overviewPage.js';
const liveMountFile = 'src/modules/serverTable.js';
const sharedStyleFile = 'src/styles/globe.css';
const mainStyleFile = 'src/styles/main.css';

// Fixed scope boundary from F-10: these branches are retained because they are
// outside the frozen legacy token set, not because their liveness is proven.
// Never derive expected declarations from the source being checked.
function mainOccurrence(declarations) {
  return Object.freeze({
    ancestors: Object.freeze([Object.freeze({ name: 'media', params: '(max-width: 600px)' })]),
    declarations: Object.freeze(
      declarations.map(([prop, value]) => Object.freeze({ prop, value, important: true })),
    ),
  });
}

const MAIN_R1 = mainOccurrence([
  ['max-width', '36vw'],
  ['max-height', '36vw'],
  ['overflow', 'hidden'],
]);
const MAIN_R2 = mainOccurrence([
  ['right', 'auto'],
  ['max-width', '32vw'],
  ['max-height', '32vw'],
  ['clip-path', 'inset(0 0 0 0)'],
]);
const MAIN_R3 = mainOccurrence([['overflow-x', 'hidden']]);
const MAIN_R4 = mainOccurrence([
  ['width', '30vw'],
  ['height', '30vw'],
  ['max-width', '30vw'],
  ['max-height', '30vw'],
  ['margin', '0'],
  ['overflow', 'hidden'],
  ['contain', 'paint'],
]);
const MAIN_R5 = mainOccurrence([
  ['max-width', '34vw'],
  ['overflow', 'hidden'],
  ['contain', 'paint'],
]);
const MAIN_SHARED_EXPECTED = Object.freeze(
  [
    ['html body .sun-corona', [MAIN_R1, MAIN_R2, MAIN_R4]],
    ['html body .solar-corona', [MAIN_R1, MAIN_R2, MAIN_R4]],
    ['html body:has(.sun-corona)', [MAIN_R3]],
    ['html body:has(.solar-corona)', [MAIN_R3]],
    ['html body .sun-widget', [MAIN_R5]],
    ['html body .solar-widget', [MAIN_R5]],
  ].map(([selector, occurrences]) => Object.freeze([selector, Object.freeze(occurrences)])),
);

function normalizeBranch(selector) {
  // Preserve descendant combinators and :has() structure; normalize layout only.
  return selector
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\(\s*/g, '(')
    .replace(/\s*\)/g, ')');
}

export function readBranchOccurrences(source, selector) {
  if (source == null) return [];
  const root = postcss.parse(source, { from: mainStyleFile });
  const occurrences = [];
  root.walkRules((rule) => {
    for (const branch of rule.selectors) {
      if (normalizeBranch(branch) !== normalizeBranch(selector)) continue;
      const ancestors = [];
      for (let parent = rule.parent; parent.type !== 'root'; parent = parent.parent) {
        if (parent.type === 'atrule') {
          ancestors.unshift({
            name: parent.name,
            params: parent.params
              .trim()
              .replace(/\s+/g, ' ')
              .replace(/\(\s*/g, '(')
              .replace(/\s*\)/g, ')')
              .replace(/\s*:\s*/g, ': '),
          });
        } else if (parent.type === 'rule') {
          // A nested rule changes selector scope even without another at-rule.
          ancestors.unshift({ selector: normalizeBranch(parent.selector) });
        }
      }
      occurrences.push({
        ancestors,
        declarations: rule.nodes
          .filter((node) => node.type === 'decl')
          .map(({ prop, value, important }) => ({ prop, value, important: Boolean(important) })),
      });
    }
  });
  return occurrences;
}

// Enumerate production source only; docs, evidence and test fixtures are not inputs.
export function readLegacySolarSources(root = new URL('../../', import.meta.url)) {
  const directory = root instanceof URL ? fileURLToPath(root) : root;
  const files = new Map();
  function readDirectory(relative) {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) readDirectory(file);
      else if (entry.isFile() && /\.(?:js|jsx|mjs|css)$/.test(file)) {
        files.set(file, readFileSync(join(directory, file), 'utf8'));
      }
    }
  }
  readDirectory('src');
  return files;
}

export function parseSolarSource(source, file) {
  return sourceParser.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    locations: true,
    sourceFile: file,
  });
}

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach((item) => walk(item, visit));
    else if (child && typeof child.type === 'string') walk(child, visit);
  }
}

function bindingNames(pattern) {
  if (!pattern) return [];
  switch (pattern.type) {
    case 'Identifier':
      return [pattern];
    case 'RestElement':
      return bindingNames(pattern.argument);
    case 'AssignmentPattern':
      return bindingNames(pattern.left);
    case 'ArrayPattern':
      return pattern.elements.flatMap(bindingNames);
    case 'ObjectPattern':
      return pattern.properties.flatMap((property) =>
        bindingNames(property.type === 'RestElement' ? property.argument : property.value),
      );
    default:
      return [];
  }
}

export function findLegacyDefinitions(asts) {
  const found = [];
  for (const [file, ast] of asts) {
    walk(ast, (node) => {
      let names = [];
      if (
        [
          'FunctionDeclaration',
          'FunctionExpression',
          'ClassDeclaration',
          'ClassExpression',
        ].includes(node.type)
      ) {
        names = bindingNames(node.id);
      } else if (node.type === 'VariableDeclarator') {
        names = bindingNames(node.id);
      } else if (node.type === 'ExportSpecifier') {
        names = [node.exported];
      }
      for (const name of names) {
        const value = name.name ?? name.value;
        if (LEGACY_APIS.includes(value)) {
          found.push({ file, line: name.loc.start.line, name: value });
        }
      }
    });
  }
  return found;
}

function findLocalFunctions(asts, name) {
  const found = [];
  for (const [file, ast] of asts) {
    walk(ast, (node) => {
      if (
        ['FunctionDeclaration', 'FunctionExpression'].includes(node.type) &&
        node.id &&
        node.id.name === name
      ) {
        found.push({
          file,
          line: node.id.loc.start.line,
          name,
          topLevelDeclaration: node.type === 'FunctionDeclaration' && ast.body.includes(node),
        });
      }
      if (
        node.type === 'VariableDeclarator' &&
        node.init &&
        ['FunctionExpression', 'ArrowFunctionExpression'].includes(node.init.type)
      ) {
        for (const binding of bindingNames(node.id)) {
          if (binding.name === name) {
            found.push({ file, line: binding.loc.start.line, name, topLevelDeclaration: false });
          }
        }
      }
    });
  }
  return found;
}

export function findLegacyDomIds(asts) {
  const found = [];
  for (const [file, ast] of asts) {
    walk(ast, (node) => {
      const value =
        node.type === 'TemplateElement'
          ? node.value.cooked
          : node.type === 'Literal' && typeof node.value === 'string'
            ? node.value
            : null;
      if (value == null) return;
      const tokens = value.split(/[^\w$-]+/);
      for (const id of LEGACY_DOM_IDS) {
        if (tokens.includes(id)) found.push({ file, line: node.loc.start.line, id });
      }
    });
  }
  return found;
}

function isLegacyClass(name) {
  return (
    LEGACY_CLASSES.includes(name) || LEGACY_CLASS_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

function decodeCssIdentifier(value) {
  return value.replace(/\\([\da-fA-F]{1,6})[ \t\r\n\f]?|\\([^\r\n\f])/g, (_, hex, character) => {
    const point = hex ? Number.parseInt(hex, 16) : null;
    return hex ? String.fromCodePoint(point > 0 && point <= 0x10ffff ? point : 0xfffd) : character;
  });
}

// Read class/id tokens, skipping comments, strings and attribute-selector values.
// PostCSS owns rule parsing and comma splitting (including functional selectors).
function selectorTokens(selector) {
  const tokens = [];
  let attributes = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const character = selector[i];
    if (selector.startsWith('/*', i)) {
      i = selector.indexOf('*/', i + 2) + 1;
    } else if (character === '"' || character === "'") {
      const quote = character;
      for (i += 1; i < selector.length; i += 1) {
        if (selector[i] === '\\') i += 1;
        else if (selector[i] === quote) break;
      }
    } else if (character === '[') {
      attributes += 1;
    } else if (character === ']') {
      attributes -= 1;
    } else if (!attributes && (character === '.' || character === '#')) {
      const match = selector
        .slice(i + 1)
        .match(/^(?:\\(?:[\da-fA-F]{1,6}[ \t\r\n\f]?|[^\r\n\f])|[-\w\u0080-\uFFFF])+/);
      if (match) {
        tokens.push({ kind: character, name: decodeCssIdentifier(match[0]) });
        i += match[0].length;
      }
    }
  }
  return tokens;
}

export function selectorHasLegacyToken(selector) {
  return selectorTokens(selector).some(({ kind, name }) =>
    kind === '#' ? LEGACY_DOM_IDS.includes(name) : isLegacyClass(name),
  );
}

export function findLegacySelectors(asts) {
  const found = [];
  for (const [file, ast] of asts) {
    ast.walkRules((rule) => {
      for (const selector of rule.selectors) {
        if (selectorHasLegacyToken(selector)) {
          found.push({ file, line: rule.source.start.line, selector });
        }
      }
    });
  }
  return found;
}

export function legacyTokensInRenderedHtml(html) {
  const found = [];
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const [tag] of withoutComments.matchAll(/<[a-z][^>]*>/gi)) {
    for (const [, attribute, double, single, bare] of tag.matchAll(
      /\s(id|class)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    )) {
      const value = double ?? single ?? bare;
      if (attribute.toLowerCase() === 'id') {
        if (LEGACY_DOM_IDS.includes(value)) found.push(value);
      } else {
        found.push(...value.split(/\s+/).filter(isLegacyClass));
      }
    }
  }
  return found;
}

export function assertLegacySunMoonRemoval({ files }) {
  assert.equal(files.has(LEGACY_ENTRY_FILE), false, 'F10_LEGACY_FILE_EXISTS');
  const sources = new Map();
  const styles = new Map();
  for (const [file, source] of files) {
    if (!file.startsWith('src/')) continue;
    if (/\.(?:js|jsx|mjs)$/.test(file)) sources.set(file, parseSolarSource(source, file));
    else if (file.endsWith('.css')) styles.set(file, postcss.parse(source, { from: file }));
  }
  const definitions = findLegacyDefinitions(sources);
  assert.deepEqual(
    definitions,
    [],
    `F10_LEGACY_DEFINITION ${definitions.map(({ file, line, name }) => `${file}:${line} ${name}`).join(', ')}`,
  );
  assert.ok(sources.has(overviewFile), `F10_OVERVIEW_FILE_MISSING ${overviewFile}:1`);
  const mounts = findLocalFunctions(sources, 'mountDisplayPage');
  // Allow only the home entry's top-level declaration, never its whole file.
  // Nested definitions in serverTable and definitions in any other src fail.
  const unexpectedMounts = mounts.filter(
    ({ file, topLevelDeclaration }) => file !== liveMountFile || !topLevelDeclaration,
  );
  assert.deepEqual(
    unexpectedMounts,
    [],
    `F10_DEAD_MOUNT_EXISTS ${unexpectedMounts.map(({ file, line, name }) => `${file}:${line} ${name}`).join(', ')}`,
  );
  assert.equal(
    mounts.length,
    1,
    `F10_LIVE_MOUNT_MISSING ${liveMountFile}:1 expected exactly one top-level mountDisplayPage declaration`,
  );
  const ids = findLegacyDomIds(sources);
  assert.deepEqual(
    ids,
    [],
    `F10_OLD_OVERVIEW_TEMPLATE ${ids.map(({ file, line, id }) => `${file}:${line} ${id}`).join(', ')}`,
  );
  const selectors = findLegacySelectors(styles);
  // Enumerate every src/**/*.css source, including main.css and new files;
  // reject any frozen legacy token in a selector branch, including media and
  // functional selectors such as :has(), with file:line and full selector.
  assert.deepEqual(
    selectors,
    [],
    `F10_LEGACY_SELECTOR ${selectors.map(({ file, line, selector }) => `${file}:${line} ${selector}`).join(', ')}`,
  );

  for (const selector of ['.globe-hint', '.globe-focus-badge']) {
    let declarations = [];
    styles.get(sharedStyleFile)?.walkRules((rule) => {
      if (
        rule.parent.type !== 'root' ||
        !rule.selectors.some(
          (branch) =>
            decodeCssIdentifier(branch.replace(/\/\*[\s\S]*?\*\//g, '').trim()) === selector,
        )
      )
        return;
      const current = rule.nodes
        .filter((node) => node.type === 'decl')
        .map(({ prop, value, important }) => ({ prop, value, important: Boolean(important) }));
      if (current.some(({ prop }) => prop === 'z-index')) declarations = current;
    });
    assert.deepEqual(
      declarations,
      [{ prop: 'z-index', value: '40', important: true }],
      `F10_SHARED_LAYER_LOST ${sharedStyleFile} ${selector}`,
    );
  }

  for (const [selector, expectedOccurrences] of MAIN_SHARED_EXPECTED) {
    assert.deepEqual(
      readBranchOccurrences(files.get(mainStyleFile), selector),
      expectedOccurrences,
      `F10_MAIN_SHARED_BRANCH_LOST ${mainStyleFile} ${selector}`,
    );
  }
}
