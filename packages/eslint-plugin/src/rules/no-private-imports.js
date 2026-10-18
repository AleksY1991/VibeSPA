import { commonProperties, importVisitors, paths } from '../paths.js';

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Keep internal implementation inside its owning micro-module or package.' },
    schema: [{ type: 'object', properties: commonProperties, additionalProperties: false }],
    messages: {
      private: '{{owner}} owns this internal implementation. Depend on its public entry point or contract; imports and reexports cannot cross its private boundary.',
    },
  },
  create(context) {
    const location = paths(context, context.options[0]);
    return importVisitors((node, source) => {
      const target = location.resolve(source);
      if (!target) return;
      const privateDirectory = target.match(/^(.*)\/internal(?:\/|$)/)?.[1];
      if (!privateDirectory) return;
      const targetOwner = location.owner(privateDirectory) ?? privateDirectory;
      const sourceOwner = location.owner(location.filename);
      if (sourceOwner === targetOwner || (!sourceOwner && location.filename.startsWith(`${targetOwner}/`))) return;
      context.report({ node, messageId: 'private', data: { owner: targetOwner } });
    });
  },
};
