import { commonProperties, paths, sourceValue } from '../paths.js';

const functionTypes = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration']);
const featureTypes = new Set(['Policy', 'Data', 'Store', 'Feature', 'Service', 'View']);
const coreImports = new Set(['@vibespa/core', '@vibespa/core/module', '@vibespa/core/data', '@vibespa/core/contributions']);
const canonicalContribution = (source, name) =>
  ((source === '@vibespa/core' || source === '@vibespa/core/settings') && name === 'settingsContributionContract')
  || ((source === '@vibespa/core' || source === '@vibespa/core/ai') && name === 'aiContributionContract');

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Keep module discovery inert and defer construction to the owning scope.' },
    schema: [{
      type: 'object', additionalProperties: false,
      properties: {
        ...commonProperties,
        declarationFactories: { type: 'array', items: { type: 'string' } },
        definitionImports: { type: 'array', items: { type: 'string' } },
      },
    }],
    messages: {
      inert: 'definition.ts is inert discovery metadata. Import types and declaration factories; defer runtime imports, construction and effects to a load factory owned by a lifetime scope.',
    },
  },
  create(context) {
    const options = context.options[0] ?? {};
    const location = paths(context, options);
    if (!/(?:^|\/)definition\.[cm]?[jt]s$/.test(location.filename)) return {};
    const factories = new Set(options.declarationFactories ?? ['defineModule', 'defineFeature', 'defineFeatureModule', 'defineDataContract', 'dataPort', 'defineContributionContract', 'contributionPort']);
    const metadataImports = new Set(options.definitionImports ?? []);
    const factoryLocals = new Set();
    const featureTypeLocals = new Set();
    const isFeatureTypeMember = node => node.object.type === 'Identifier'
      && featureTypeLocals.has(node.object.name)
      && featureTypes.has(node.computed ? node.property.value : node.property.name);
    const deferred = node => {
      for (let current = node; current?.parent; current = current.parent) {
        if (functionTypes.has(current.type) && current.parent.type === 'Property'
          && (current.parent.key.name ?? current.parent.key.value) === 'load'
          && current.parent.value === current && current.parent.kind === 'init') return true;
      }
      return false;
    };
    const report = node => context.report({ node, messageId: 'inert' });
    const effect = node => { if (!deferred(node)) report(node); };
    return {
      ImportDeclaration(node) {
        if (node.importKind === 'type' || (node.specifiers.length > 0 && node.specifiers.every(item => item.importKind === 'type'))) return;
        const source = sourceValue(node.source);
        const allowedSpecifier = item => item.importKind === 'type' || (item.type === 'ImportSpecifier'
          && ((coreImports.has(source) && factories.has(item.imported.name))
            || canonicalContribution(source, item.imported.name)
            || ((source === '@vibespa/contracts' || coreImports.has(source)) && item.imported.name === 'FeatureType')));
        if (node.specifiers.length > 0 && node.specifiers.every(allowedSpecifier)) {
          for (const specifier of node.specifiers) {
            if (specifier.importKind === 'type') continue;
            if (specifier.imported.name === 'FeatureType') featureTypeLocals.add(specifier.local.name);
            else if (factories.has(specifier.imported.name)) factoryLocals.add(specifier.local.name);
          }
          return;
        }
        // Public contracts and other inert definitions carry canonical data
        // references. They may be imported by name; runtime internals stay lazy.
        const publicMetadata = typeof source === 'string' && source.startsWith('.')
          && /(?:^|\/)(?:contract|definition)(?:\.[cm]?[jt]s)?$/.test(source)
          && !/(?:^|\/)internal(?:\/|$)/.test(location.resolve(source))
          && node.specifiers.every(item => item.type === 'ImportSpecifier');
        if ((!metadataImports.has(source) && !publicMetadata) || node.specifiers.length === 0) report(node);
      },
      ExportNamedDeclaration(node) { if (node.source && node.exportKind !== 'type') report(node); },
      ExportAllDeclaration(node) { if (node.exportKind !== 'type') report(node); },
      CallExpression(node) {
        if (deferred(node)) return;
        if (node.callee.type === 'Identifier' && factoryLocals.has(node.callee.name)) return;
        report(node);
      },
      NewExpression: effect,
      ImportExpression: effect,
      TaggedTemplateExpression: effect,
      AwaitExpression: effect,
      AssignmentExpression: effect,
      UpdateExpression: effect,
      ThrowStatement: effect,
      ForStatement: effect,
      ForOfStatement: effect,
      ForInStatement: effect,
      WhileStatement: effect,
      DoWhileStatement: effect,
      FunctionDeclaration: effect,
      ArrowFunctionExpression: effect,
      FunctionExpression: effect,
      MemberExpression(node) {
        if (['CallExpression', 'NewExpression'].includes(node.parent.type) && node.parent.callee === node) return;
        if (node.parent.type === 'AssignmentExpression' && node.parent.left === node) return;
        if (node.parent.type === 'MemberExpression' && node.parent.object === node) return;
        if (isFeatureTypeMember(node)) return;
        effect(node);
      },
      UnaryExpression(node) { if (node.operator === 'delete') effect(node); },
    };
  },
};
