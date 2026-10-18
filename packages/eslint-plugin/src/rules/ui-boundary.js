import { commonProperties, defaults, importVisitors, matches, memberName, paths, sourceValue } from '../paths.js';

const renderingPackages = /^(?:solid-js\/web|@solidjs\/web|react-dom|react|preact|vue|@angular\/core)(?:\/|$)/;
const renderingFunctions = new Set(['render', 'hydrate', 'createElement', 'createComponent', 'createPortal']);
const domCalls = new Set(['createElement', 'createElementNS', 'createTextNode', 'createDocumentFragment', 'querySelector', 'querySelectorAll', 'getElementById', 'insertAdjacentHTML']);
const domTypes = /^(?:HTMLElement|Element|Document|Window|EventTarget|KeyboardEvent|MouseEvent|PointerEvent|FocusEvent|(?:HTML|SVG|CSS|DOM)\w*|(?:Mutation|Resize|Intersection)Observer)$/;
const packageMatch = (source, packages) => packages.some(name => source === name || source.startsWith(`${name}/`));
const array = { type: 'array', items: { type: 'string' } };

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Keep presentation in UI adapters and semantic values in domain modules.' },
    schema: [{
      type: 'object', additionalProperties: false,
      properties: {
        ...commonProperties, domainRoots: array, uiRoots: array, contractRoots: array,
        uiAdapters: array, allowedUiImports: array, forbiddenUiImports: array,
      },
    }],
    messages: {
      presentation: 'UI owns rendering, DOM access and CSS. Expose semantic values and commands here; connect them to a view through an explicit UI adapter.',
      dependency: 'UI consumes contracts and its own presentation modules. Adapt business, storage and runtime capabilities to a narrow contract at the composition boundary.',
      domContract: 'Contracts carry semantic values and commands. Keep DOM and rendering types inside the UI adapter.',
    },
  },
  create(context) {
    const options = { ...defaults, ...context.options[0] };
    const location = paths(context, options);
    const inUi = matches(location.filename, options.uiRoots);
    const inContracts = matches(location.filename, options.contractRoots);
    const domain = matches(location.filename, options.domainRoots) && !matches(location.filename, options.uiAdapters);
    if (!inUi && !domain && !inContracts) return {};
    const namespaces = new Set();
    const renderLocals = new Set();
    const global = node => {
      for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
        const variable = scope.set.get(node.name);
        if (variable) return variable.defs.length === 0;
      }
      return true;
    };
    const report = node => context.report({ node, messageId: 'presentation' });
    const imports = importVisitors((node, source) => {
      if (typeof source !== 'string') return;
      const target = location.resolve(source);
      if (inUi) {
        const allowed = packageMatch(source, options.allowedUiImports) || matches(target, options.contractRoots);
        const localSource = source.startsWith('.') || source.startsWith('@/') || source.startsWith('#');
        if (!allowed && (matches(target, options.domainRoots)
          || packageMatch(source, options.forbiddenUiImports)
          || (localSource && !matches(target, options.uiRoots)))) {
          context.report({ node, messageId: 'dependency' });
        }
      }
      if (domain || inContracts) {
        if (/\.(?:css|scss|sass|less)(?:\?|$)/.test(source) || renderingPackages.test(source)
          || matches(target, options.uiRoots) || packageMatch(source, ['@vibespa/solid'])) report(node);
        if (node.type === 'ImportDeclaration' && source === 'solid-js') {
          for (const specifier of node.specifiers) {
            if (specifier.type === 'ImportNamespaceSpecifier' || specifier.type === 'ImportDefaultSpecifier') namespaces.add(specifier.local.name);
            if (renderingFunctions.has(specifier.imported?.name)) { renderLocals.add(specifier.local.name); report(specifier); }
          }
        }
      }
    });
    return {
      ...imports,
      JSXElement(node) { if (domain || inContracts) report(node); },
      JSXFragment(node) { if (domain || inContracts) report(node); },
      CallExpression(node) {
        imports.CallExpression(node);
        if (!domain && !inContracts) return;
        const method = memberName(node.callee);
        if (domCalls.has(method) || (node.callee.type === 'Identifier' && renderLocals.has(node.callee.name))
          || (node.callee.type === 'MemberExpression' && namespaces.has(node.callee.object.name) && renderingFunctions.has(method))) report(node);
        else if ((['setAttribute', 'removeAttribute'].includes(method) && ['class', 'style'].includes(sourceValue(node.arguments[0])))
          || (node.callee.type === 'MemberExpression' && ['style', 'classList'].includes(memberName(node.callee.object)))) report(node);
      },
      MemberExpression(node) {
        if (!domain && !inContracts) return;
        if (node.parent.type === 'MemberExpression' && node.parent.object === node) return;
        if (node.parent.type === 'CallExpression' && node.parent.callee === node && domCalls.has(memberName(node))) return;
        if (node.parent.type === 'AssignmentExpression' && node.parent.left === node
          && ['style', 'className', 'innerHTML', 'outerHTML'].includes(memberName(node))) return;
        let root = node;
        while (root.object?.type === 'MemberExpression') root = root.object;
        if (root.object?.type !== 'Identifier' || !global(root.object)) return;
        if (['document', 'window'].includes(root.object.name)
          || (root.object.name === 'globalThis' && ['document', 'window'].includes(memberName(root)))) report(node);
      },
      AssignmentExpression(node) {
        if (!domain && !inContracts) return;
        for (let target = node.left; target?.type === 'MemberExpression'; target = target.object) {
          if (['style', 'className', 'innerHTML', 'outerHTML'].includes(memberName(target))) { report(node); break; }
        }
      },
      TSTypeReference(node) {
        if (!inContracts) return;
        const name = node.typeName;
        if ((name.type === 'Identifier' && domTypes.test(name.name) && global(name))
          || (name.type === 'TSQualifiedName' && ['JSX', 'globalThis'].includes(name.left.name))) {
          context.report({ node, messageId: 'domContract' });
        }
      },
    };
  },
};
