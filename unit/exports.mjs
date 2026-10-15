export const ALL = '*';
export const BODY = '\0body';

const literal = (node) => {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return undefined;
};

const named = (node) => (node.type === 'Literal' ? String(node.value) : node.name);

const metaUrl = (node) =>
  node?.type === 'MemberExpression' &&
  node.object.type === 'MetaProperty' &&
  node.property.name === 'url';

function dynamic(node) {
  switch (node.type) {
    case 'ImportExpression':
      return literal(node.source);
    case 'CallExpression':
      return node.callee.type === 'Identifier' && node.callee.name === 'require'
        ? literal(node.arguments[0])
        : undefined;
    case 'NewExpression':
      return node.callee.type === 'Identifier' &&
        node.callee.name === 'URL' &&
        metaUrl(node.arguments[1])
        ? literal(node.arguments[0])
        : undefined;
    default:
      return undefined;
  }
}

function dynamics(ast) {
  const found = [];
  const stack = [ast];
  while (stack.length > 0) {
    const node = stack.pop();
    const value = dynamic(node);
    if (value !== undefined) found.push(value);
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof item.type === 'string') stack.push(item);
      } else if (child && typeof child.type === 'string') {
        stack.push(child);
      }
    }
  }
  return found;
}

function bound(pattern, out = []) {
  if (!pattern) return out;
  switch (pattern.type) {
    case 'Identifier':
      out.push(pattern.name);
      break;
    case 'ObjectPattern':
      for (const property of pattern.properties) bound(property.value ?? property.argument, out);
      break;
    case 'ArrayPattern':
      for (const element of pattern.elements) bound(element, out);
      break;
    case 'RestElement':
      bound(pattern.argument, out);
      break;
    case 'AssignmentPattern':
      bound(pattern.left, out);
      break;
    default:
      break;
  }
  return out;
}

function declared(declaration) {
  if (declaration.type === 'VariableDeclaration') {
    return declaration.declarations.flatMap((item) => bound(item.id));
  }
  return declaration.id ? [declaration.id.name] : [];
}

function imported(node, info) {
  const names = new Set();
  for (const item of node.specifiers) {
    let name = ALL;
    if (item.type === 'ImportDefaultSpecifier') name = 'default';
    else if (item.type === 'ImportSpecifier') name = named(item.imported);
    names.add(name);
    info.bindings.set(item.local.name, { spec: node.source.value, name });
  }
  info.imports.push({ spec: node.source.value, names: names.size > 0 ? [...names] : [BODY] });
}

function exported(node, info) {
  if (node.declaration) {
    for (const name of declared(node.declaration)) info.locals.add(name);
    return;
  }
  for (const item of node.specifiers) {
    const local = named(item.local);
    const name = named(item.exported);
    if (node.source) info.reexports.set(name, { spec: node.source.value, name: local });
    else info.aliases.set(name, local);
  }
}

function exportedDefault(node, info) {
  const { declaration } = node;
  if (declaration.type === 'Identifier') info.aliases.set('default', declaration.name);
  else info.locals.add('default');
}

const handlers = {
  ImportDeclaration: imported,
  ExportNamedDeclaration: exported,
  ExportDefaultDeclaration: exportedDefault,
  ExportAllDeclaration: (node, info) => {
    if (node.exported) {
      info.reexports.set(named(node.exported), { spec: node.source.value, name: ALL });
    } else {
      info.stars.push(node.source.value);
    }
  },
};

export function describe(ast) {
  const info = {
    whole: ast.sourceType !== 'module',
    imports: [],
    bindings: new Map(),
    aliases: new Map(),
    locals: new Set(),
    reexports: new Map(),
    stars: [],
    dynamic: dynamics(ast),
  };
  for (const node of ast.body) handlers[node.type]?.(node, info);
  for (const [name, local] of info.aliases) {
    if (info.bindings.has(local)) info.reexports.set(name, info.bindings.get(local));
    else info.locals.add(name);
  }
  return info;
}
